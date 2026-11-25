using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(
    builder.Configuration.GetConnectionString("Workshop")
    ?? throw new InvalidOperationException("Missing Workshop connection string")));
builder.Services.AddMemoryCache(o => o.SizeLimit = 1000);
builder.Services.AddSingleton<Stats>();
builder.Services.AddSingleton<Catalogue>();
var app = builder.Build();
app.Use(async (context, next) =>
{
    context.Response.Headers["X-Instance"] = Environment.MachineName;
    if (context.Request.Path.StartsWithSegments("/api"))
        context.Response.Headers.CacheControl = "no-store";
    try { await next(); }
    catch (Exception ex) when (ex is NpgsqlException or TimeoutException)
    {
        app.Logger.LogWarning("Database unavailable: {Type}", ex.GetType().Name);
        if (!context.Response.HasStarted)
        {
            context.Response.StatusCode = 503;
            await context.Response.WriteAsJsonAsync(new { error = "Database temporarily unavailable" });
        }
    }
});
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl =
        ctx.File.Name == "app.v1.js" ? "public,max-age=31536000,immutable" : "no-cache"
});
app.MapGet("/api/health", async (NpgsqlDataSource db, CancellationToken ct) =>
{
    await using var cmd = db.CreateCommand("SELECT 1");
    await cmd.ExecuteScalarAsync(ct);
    return Results.Ok(new { status = "ready" });
});
app.MapGet("/api/stats", (Stats stats) => Results.Ok(stats.Snapshot()));
app.MapGet("/api/lessons", async (HttpContext context, Catalogue catalogue,
    string? language, int? page, int? pageSize, string? cache, CancellationToken ct) =>
{
    language ??= "nl";
    cache ??= "none";
    var p = page ?? 1;
    var size = pageSize ?? 20;
    if (!Catalogue.ValidLanguage(language) || p is < 1 or > 100 || size is < 1 or > 100
        || cache is not ("none" or "memory"))
        return Results.BadRequest(new { error = "language=nl|fr|de, page=1..100, pageSize=1..100, cache=none|memory" });
    var result = await catalogue.Read(language, p, size, cache, ct);
    context.Response.Headers["X-Cache"] = result.Status;
    context.Response.Headers["X-Data-Version"] = result.Data.Version.ToString();
    context.Response.Headers["X-Cache-Key"] = result.Key;
    return Results.Ok(result.Data);
});
app.MapGet("/api/lessons/{id:long}", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
{
    await using var cmd = db.CreateCommand("SELECT id, language, title, content, created_at FROM lessons WHERE id = $1");
    cmd.Parameters.AddWithValue(id);
    await using var reader = await cmd.ExecuteReaderAsync(ct);
    return await reader.ReadAsync(ct) ? Results.Ok(Catalogue.Map(reader)) : Results.NotFound();
});
app.MapPost("/api/lessons", async (NewLesson input, NpgsqlDataSource db, Stats stats, CancellationToken ct) =>
{
    if (!Catalogue.ValidLanguage(input.Language) || string.IsNullOrWhiteSpace(input.Title)
        || input.Title.Length > 120 || string.IsNullOrWhiteSpace(input.Content) || input.Content.Length > 2000)
        return Results.BadRequest(new { error = "Valid language, title (1..120), content (1..2000) required" });
    await using var conn = await db.OpenConnectionAsync(ct);
    await using var tx = await conn.BeginTransactionAsync(ct);
    Lesson lesson;
    await using (var cmd = new NpgsqlCommand("""
        INSERT INTO lessons (language, title, content) VALUES ($1, $2, $3)
        RETURNING id, language, title, content, created_at
        """, conn, tx))
    {
        cmd.Parameters.AddWithValue(input.Language!);
        cmd.Parameters.AddWithValue(input.Title);
        cmd.Parameters.AddWithValue(input.Content);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        await reader.ReadAsync(ct);
        lesson = Catalogue.Map(reader);
    }
    // The row and cache generation change together for invalidation on every API copy.
    await using (var cmd = new NpgsqlCommand("UPDATE catalogue_version SET version = version + 1", conn, tx))
        await cmd.ExecuteNonQueryAsync(ct);
    await tx.CommitAsync(ct);
    Interlocked.Increment(ref stats.Writes);
    return Results.Created($"/api/lessons/{lesson.Id}", lesson);
});
app.Run();

record NewLesson(string? Language, string? Title, string? Content);
record Lesson(long Id, string Language, string Title, string Content, DateTime CreatedAt);
record LessonPage(long Version, string Language, int Page, int PageSize, List<Lesson> Items);
record CachedPage(LessonPage Data, string Status, string Key);

class Stats
{
    public long VersionQueries, ListQueries, Hits, Misses, Writes;
    public long ListQueryTicks;
    public object Snapshot() => new
    {
        instance = Environment.MachineName,
        versionQueries = Interlocked.Read(ref VersionQueries),
        listQueries = Interlocked.Read(ref ListQueries),
        cacheHits = Interlocked.Read(ref Hits),
        cacheMisses = Interlocked.Read(ref Misses),
        writes = Interlocked.Read(ref Writes),
        listQueryTotalMs = Interlocked.Read(ref ListQueryTicks) * 1000.0 / Stopwatch.Frequency
    };
}

class Catalogue(NpgsqlDataSource db, IMemoryCache memory,
    IConfiguration config, Stats stats)
{
    readonly TimeSpan ttl = TimeSpan.FromSeconds(Math.Clamp(config.GetValue("CacheTtlSeconds", 30), 1, 300));
    readonly int delay = Math.Clamp(config.GetValue("DemoQueryDelayMs", 0), 0, 1000);
    // Bound expensive list work per API; the connection pool also bounds DB connections.
    readonly SemaphoreSlim listSlots = new(16);

    public static bool ValidLanguage(string? value) => value is "nl" or "fr" or "de";
    public static Lesson Map(NpgsqlDataReader r) => new(r.GetInt64(0), r.GetString(1),
        r.GetString(2), r.GetString(3), r.GetDateTime(4));

    public async Task<CachedPage> Read(string language, int page, int size, string mode, CancellationToken ct)
    {
        Interlocked.Increment(ref stats.VersionQueries);
        await using var versionCmd = db.CreateCommand("SELECT version FROM catalogue_version WHERE singleton = true");
        var version = (long)(await versionCmd.ExecuteScalarAsync(ct))!;
        var key = $"lessons:v1:scope-public:lang-{language}:generation-{version}:page-{page}:size-{size}";
        var status = mode == "none" ? "BYPASS" : "MISS";
        if (mode == "memory" && memory.TryGetValue(key, out LessonPage? found) && found is not null)
        {
            Interlocked.Increment(ref stats.Hits);
            return new(found, "HIT", key);
        }
        if (mode != "none") Interlocked.Increment(ref stats.Misses);
        await listSlots.WaitAsync(ct);
        LessonPage data;
        try
        {
            var start = Stopwatch.GetTimestamp();
            Interlocked.Increment(ref stats.ListQueries);
            // Explicit artificial delay for a separate teaching experiment; default is zero.
            if (delay > 0) await Task.Delay(delay, ct);
            await using var cmd = db.CreateCommand("""
                SELECT id, language, title, content, created_at FROM lessons
                WHERE language = $1 ORDER BY id DESC LIMIT $2 OFFSET $3
                """);
            cmd.Parameters.AddWithValue(language);
            cmd.Parameters.AddWithValue(size);
            cmd.Parameters.AddWithValue((page - 1) * size);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            var items = new List<Lesson>();
            while (await reader.ReadAsync(ct)) items.Add(Map(reader));
            data = new(version, language, page, size, items);
            Interlocked.Add(ref stats.ListQueryTicks, Stopwatch.GetTimestamp() - start);
        }
        finally { listSlots.Release(); }
        if (mode == "memory") memory.Set(key, data, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = ttl, Size = 1 });
        return new(data, status, key);
    }
}
