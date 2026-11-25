# Workshop: performance testing and caching with Docker and k6

Test a standalone lesson catalogue with **GET records** and **POST records**. Docker Compose runs PostgreSQL, a .NET 10 API and k6. Distinguish load, stress, spike and soak testing; compare latency, correctness, resources and caching, then check freshness and independent API caches.

Use the standalone repository **[mcloots/swe_performance](https://github.com/mcloots/swe_performance)** for all source code, Docker configuration and k6 scripts. Commands below run from that repository's root, containing `compose.yaml`, using PowerShell. Docker Desktop with Linux containers and a browser are sufficient. You need no local SDK, Node.js, PostgreSQL or k6. The first build needs internet access.

Allow about **three hours** for setup/contracts, baseline/load, caching/freshness, multiple instances and browser observations. Add about **30 minutes** for the stress/spike exercises and discussion. A genuine soak test runs separately for hours; its two-minute classroom preview only verifies the setup.

## Learning goals and course connection

Choose a test type from the risk you want to investigate. Define a workload, distinguish request rate from virtual users, interpret p50/p95/p99, validate responses, and assess caching using server evidence. Explain cache keys, expiry, invalidation, access scope and recovery behaviour.

This follows the supplied **PSR slides**: smaller queries and bounded work (14–15), scaling up/out (19–21), caching layers and freshness/access/failure (22–24), fair load comparisons (25), and visibility (33). All traffic settings and performance budgets here are synthetic teaching examples, not measured product capacity.

| Course layer | Implementation | Work avoided on a hit |
| --- | --- | --- |
| Browser HTTP cache | Immutable, versioned `app.v1.js` | Downloading the same JavaScript |
| Frontend data cache | Optional 10-second JavaScript Map | Repeating an API request |
| API memory | `IMemoryCache`, `cache=memory` | Executing the list query in one API copy |
| CDN / edge | Discussion exercise; no external CDN deployed | Transferring public files from a distant origin |

Records are **public synthetic lessons**, in NL/FR/DE. There is no authentication or class authorization. A private catalogue must authorize each request and scope its keys appropriately; a key containing `scope-public` does not implement permissions.

Each exercise includes **possible problems and solutions**: first identify the signal, then choose one change and repeat the same workload. Proposed solutions and snippets are discussion material; only behaviour explicitly described as implemented exists in the supplied API. Snippets show the essential change and may require surrounding types/configuration.

## 1. Start and verify the stack

Clone the workshop repository and open its root. If you already cloned it, open that directory and skip the first two commands:

```powershell
git clone https://github.com/mcloots/swe_performance.git
cd swe_performance
docker compose up -d --build --wait
Invoke-RestMethod http://localhost:53120/api/health
docker compose run --rm k6 run /scripts/verify.js
```

Wait for health to return `status: ready`; retry it if the API is still starting. Compose checks PostgreSQL health; the API has no container health probe. `verify.js` checks contracts, cache hits, language/page separation and invalidation after POST. It adds two fixture rows. Fix failed checks before measuring load.

Open **http://localhost:53120**. The API serves the demo page itself; no frontend build or CORS setup is needed. PostgreSQL is only exposed inside the Docker network. API ports bind to localhost. Credentials are for this disposable local stack.

| Endpoint | Contract |
| --- | --- |
| `GET /api/health` | `200`; checks PostgreSQL connectivity |
| `GET /api/lessons?language=nl&page=1&pageSize=20&cache=none` | `200`, generation, language, pagination and records ordered by ID descending |
| Same GET with `cache=memory` | Same body contract with a different retrieval strategy |
| `POST /api/lessons` | `201`, saved record and `Location: /api/lessons/{id}` |
| `GET /api/lessons/{id}` | Uncached single record, `404` if unknown |
| `GET /api/stats` | Per-instance counters since startup |

Create a record and check persistence:

```powershell
$body = @{ language = 'nl'; title = 'Workshop fixture'; content = 'A synthetic lesson.' } | ConvertTo-Json
$created = Invoke-RestMethod -Method Post -Uri http://localhost:53120/api/lessons -ContentType 'application/json' -Body $body
Invoke-RestMethod "http://localhost:53120/api/lessons/$($created.id)"
docker compose exec db psql -U workshop -d workshop -c "SELECT id, language, title FROM lessons ORDER BY id DESC LIMIT 3;"
```

The SQL initializer creates **30,000 rows**, 10,000 per language, with an index on `(language, id DESC)`. It runs only for a new volume. The API filters, sorts, selects fields and paginates in SQL. It never loads all records to choose a page. Page and page-size ranges are 1–100. POST requires a supported language, title of 1–120 characters and content of 1–2,000 characters.

**Checkpoint:** trace GET and POST through `api/Program.cs` and `db/001-init.sql`. Which operations access PostgreSQL? Why do we read back the record instead of relying only on the POST response?

### Possible problems and solutions: startup and request size

- **Long first startup:** distinguish image downloads/build time from API request latency. Pre-pull and build before class, reuse build layers, and warm the runtime before measuring. A cold-start requirement needs a separate cold-start measurement.
- **Large or expensive requests:** enforce byte limits as well as field/page limits, return only required fields, and propagate cancellation to database calls. These protect different resources; a short title limit does not bound the entire HTTP body.
- **Unexpectedly empty or wrong records:** resolve database initialization and contract failures first. Faster incorrect responses do not count as a performance improvement.

## 2. Compare open-source load-testing tools

| Tool | Useful when | Trade-off here |
| --- | --- | --- |
| [Apache JMeter](https://jmeter.apache.org/usermanual/get-started.html) | Visual test plans and multiple protocols | Needs Java and test-plan familiarity; generate load in CLI mode |
| [Locust](https://docs.locust.io/en/stable/writing-a-locustfile.html) | Python user journeys | User count alone does not define a fixed request arrival rate |
| [Gatling](https://docs.gatling.io/reference/deploy/install-local/) | Structured code scenarios and reports | Adds DSL and project setup |
| [wrk](https://github.com/wg/wrk) | Quick HTTP throughput experiments | Standard options control connections/threads; contract checks and budgets need extra scripting |
| [Grafana k6](https://grafana.com/docs/k6/latest/) | Small scripts with arrival rates, checks and thresholds | Uses its own JavaScript runtime rather than arbitrary Node.js packages |

We use k6 because requests, checks, workload and budgets fit in one reviewable script. Docker supplies the runtime. This is a workflow choice, not a ranking of load-generation capacity.

Read `k6/load.js`. Locate environment settings, scenarios, HTTP calls, checks and thresholds. Each iteration sends **one HTTP request**. `TARGET=read` sends GET, `TARGET=write` sends POST, and `TARGET=mixed` sends one POST for every ten scheduled iterations. Redirects and retries are disabled.

With [`constant-arrival-rate`](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/), 20 iterations/s plans 20 requests/s independently of response duration, provided workers and generator resources suffice. A VU is an available worker, not a request rate or logged-in user. At 50 requests/s and five seconds per response, approximately 250 concurrent workers would be needed. Defaults allocate 20 VUs and allow 100. There is no `sleep`; the executor controls pacing.

### Four performance test types

Reference for class discussion: [the supplied video](https://www.youtube.com/watch?v=ghuo8m7AXEM). Compare its explanations with the four goals below. Definitions here follow the [official k6 test-type guide](https://grafana.com/docs/k6/latest/testing-guides/test-types/); the request rates and timings are our own workshop examples, not a reproduction of the video's measurements.

| Type | Main question | Traffic shape in this workshop | What makes it different? |
| --- | --- | --- | --- |
| **Load testing** | Does the API meet its budgets under expected traffic? | Hold 20 requests/s for 60 seconds | Establish normal behaviour and a repeatable baseline |
| **Stress testing** | How does it behave above expected load, and does it recover? | Baseline, gradually increase to 100/s, hold, then return to 20/s | Investigate high-load degradation and recovery |
| **Spike testing** | Can it handle a sudden burst and return to normal? | Baseline, jump from 20 to 200/s in one second, briefly hold, drop back | The speed of the change exposes different risks from a gradual ramp |
| **Soak testing** | Does performance remain stable over prolonged use? | Hold a sustainable 20/s for two hours | Look for accumulated resource use and time-dependent degradation |

Here **load testing** means an average-load test; it is also used as an umbrella term for the whole family. These are not four different endpoints or tools: we reuse the same operation and checks, changing the traffic pattern and observation window. Stress does not have to crash the API. A test that keeps increasing until it discovers a breaking point is a related **breakpoint test**, which is outside these four supplied profiles.

`TARGET=read|write|mixed` chooses the operation; `TEST_TYPE=load|stress|spike|soak` independently chooses the workload. `CACHE=none|memory` chooses the API cache. The default remains `TEST_TYPE=load`, so the existing baseline commands still work. `k6/profiles.js` contains the four profiles; `k6/load.js` contains the shared requests/checks.

| Profile setting | Meaning |
| --- | --- |
| `RATE` | Normal rate, default 20 requests/s |
| `DURATION` | Steady load/soak duration; default 60s for load, 2h for soak |
| `STRESS_RATE` / `SPIKE_RATE` | Peak rate; defaults are 5 × / 10 × `RATE` |
| `TIME_SCALE` | Multiplier for all stress/spike stage durations; default 1 |
| `PRE_ALLOCATED_VUS` / `MAX_VUS` | Generator worker budget; defaults remain 20 / 100 |

Stress/spike use [`ramping-arrival-rate`](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/), with target **requests/s**, not target VUs. They reject `DURATION`; use `TIME_SCALE` to shorten stages. Shortened profiles validate script behaviour, not long-duration stability. Set the normal rate from a requirement or representative traffic; 20/s is only our synthetic classroom assumption.

### Possible problems and solutions: generating the intended load

If the generator is CPU-bound, remove expensive per-request logging/check computations, allocate generator resources, or move it to another machine. If VUs are unavailable, estimate concurrency from rate and response duration, then adjust VU allocation. If the server is slow, investigate its waits; increasing VUs alone can make overload worse. Keep one request per iteration when interpreting the configured rate as requests/s.

## 3. Measure a GET baseline without caching

Warm up, then run two identical baselines sequentially:

```powershell
docker compose run --rm k6 run -e TARGET=read -e CACHE=none -e RATE=1 -e DURATION=15s /scripts/load.js
docker compose run --rm k6 run -e TARGET=read -e CACHE=none -e RATE=20 -e DURATION=60s --summary-export=/results/read-none-1.json /scripts/load.js
docker compose run --rm k6 run -e TARGET=read -e CACHE=none -e RATE=20 -e DURATION=60s --summary-export=/results/read-none-2.json /scripts/load.js
$LASTEXITCODE
```

Each measurement plans 1,200 requests. Reports appear in local `results/`. We repeatedly read NL page 1 with 20 records: a **hot-page workload**. Database buffers can already be warm with application caching disabled.

Example budgets: p95 below 500 ms, fewer than 1% HTTP failures, fewer than 1% incorrect responses, and zero dropped iterations. A `200` with the wrong page, language, order or content structure still fails `failed_responses`. This metric counts one boolean sample per response. Several failed checks on one response count as one wrong response. Checks record assertions; [thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/) determine a nonzero exit code.

| Metric | Interpretation |
| --- | --- |
| `http_reqs` | Actually sent requests; compare with rate × scheduled seconds |
| `iterations` | Completed iterations; inspect interrupted work too |
| `med`, `p(95)`, `p(99)` | p50/p95/p99; p99 is not the maximum |
| `http_req_failed` | Transport errors or unexpected HTTP statuses |
| `failed_responses` | Incorrect responses, counted per response |
| `dropped_iterations` | Planned work the generator could not start |
| `cache_hits` | Fraction of reads reporting an API cache hit |

`http_req_duration` includes API/database waiting, excludes initial connection establishment, and does not measure rendering. Short runs give weak evidence for p99. Summary rates can include finishing in-flight work: compare counts and scheduled duration too.

Collect server evidence before and after every measurement:

```powershell
Invoke-RestMethod http://localhost:53120/api/stats
docker compose stats --no-stream
docker compose exec db psql -U workshop -d workshop -c "SELECT state, wait_event_type, count(*) FROM pg_stat_activity WHERE datname = 'workshop' GROUP BY state, wait_event_type;"
```

Counters are cumulative and per instance: use **deltas**. `listQueries` counts list executions; `versionQueries` counts freshness lookups. `cacheHits`, `cacheMisses` and `writes` explain behaviour. `listQueryTotalMs` sums list execution time, including any teaching delay, excluding semaphore waiting. It is not a database-only trace or request percentile. Health/single-record queries are excluded from these counters. Resource snapshots can miss peaks.

**Checkpoint:** record typical/tail latency, errors, dropped work and list-query delta. Why does a fast health endpoint not establish list performance?

### Possible problems and solutions: slow GETs

| Observation / evidence | Possible solution | Verify afterward |
| --- | --- | --- |
| Query plan scans/sorts many rows | Match an index to filter and ordering; paginate in SQL | Compare plan, buffers, query time and write cost; this demo already has the matching index |
| Large responses or API serialization CPU | Return summary fields and fetch full content only on detail requests | Compare response bytes, CPU and p95 with the same logical page |
| Deeper pages get slower with OFFSET | Use a cursor/keyset for sequential navigation | Compare equivalent pages; cursor navigation changes the client contract |
| Repeated identical list queries dominate | Enable the existing memory cache and measure hit rate | Check both list-query delta and request latency |
| Large tails despite modest average CPU | Inspect pool waits, locks, GC and concurrent work | Compare p95/p99 and waiting after one targeted change |

An essential SQL sketch for cursor pagination is:

```sql
SELECT id, language, title
FROM lessons
WHERE language = $1 AND id < $2 -- last ID on the previous page
ORDER BY id DESC
LIMIT $3;
```

For the first page, omit the cursor predicate. The existing `(language, id DESC)` index supports this ordering. This changes the current page-number contract and does not support arbitrary jumps to page 70. See [query projection and pagination guidance](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying) and PostgreSQL's [LIMIT/OFFSET rules](https://www.postgresql.org/docs/18/queries-limit.html).

## 4. Compare higher load, stress, spike and soak tests

### 4.1. Increase GET load and measure POST separately

Predict what changes at 50/s, then test:

```powershell
docker compose run --rm k6 run -e TARGET=read -e CACHE=none -e RATE=50 -e DURATION=60s --summary-export=/results/read-none-50.json /scripts/load.js
docker compose run --rm k6 run -e TARGET=write -e ALLOW_WRITES=true -e RATE=1 -e DURATION=15s /scripts/load.js
docker compose run --rm k6 run -e TARGET=write -e ALLOW_WRITES=true -e RATE=20 -e DURATION=60s --summary-export=/results/write-20.json /scripts/load.js
docker compose run --rm k6 run -e TARGET=write -e ALLOW_WRITES=true -e RATE=50 -e DURATION=60s --summary-export=/results/write-50.json /scripts/load.js
```

Writes insert real rows: 20/s for 60 seconds plans 1,200 records; 50/s plans 3,000. The script requires `ALLOW_WRITES=true`, uses synthetic titles and validates `201`, payload, ID, timestamp and Location. Verify a stored row through SQL afterward. A timed-out POST may have committed; this API has no idempotency key, so do not retry automatically.

A GET cache does not remove INSERT work. POST still waits for PostgreSQL commit and updates a singleton catalogue-generation row in the same transaction. That simple invalidation strategy can serialize concurrent writes and become a write bottleneck. Investigate database waits before adding API copies.

If iterations drop, investigate both the generator and the system: [dropped iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/) can reflect insufficient VUs or degraded response. After checking resources, repeat the **same rate** with `-e PRE_ALLOCATED_VUS=100 -e MAX_VUS=100`. More workers allow concurrency; they do not repair a slow query.

Prove that a failed budget controls exit status:

```powershell
docker compose run --rm k6 run -e TARGET=read -e RATE=1 -e DURATION=5s -e P95_MS=0.001 /scripts/load.js
$LASTEXITCODE
```

Expect a nonzero code from the deliberately unrealistic latency budget, even if correctness checks pass.

### Possible problems and solutions: POST and overload

| Observation / evidence | Possible solution | Cost or limit |
| --- | --- | --- |
| Concurrent POSTs wait on the singleton generation row | Keep the transaction short; consider one generation row per language and update only that row | Both reads and writes must adopt the new scheme; writes in the same language can still contend |
| INSERT cost grows as data/indexes grow | Inspect write/WAL/storage time; remove redundant indexes only after checking read needs | An index helps reads but adds write work; the existing list index is useful |
| Blocking calls or pool exhaustion increase latency | Keep I/O async, dispose readers/connections promptly, bound concurrency | The sample already uses async I/O and pooling; blindly raising pool size is not a fix |
| A timeout leads to duplicate POST retries | Persist an operation ID with a unique database constraint and reuse it on retry | This is a proposed correctness extension, not implemented; disabling the button only protects one page |
| Long-running optional work delays `201` | Move optional work to a bounded background process after a durable handoff | Confirm saved versus completed work separately; do not acknowledge storage before commit |
| Latency rises and errors/drops grow under overload | Bound admission/queues, optimize the measured bottleneck, then consider more capacity | Lowering the offered rate is traffic control, not proof of increased capacity |

The limiter sketch in section 7 shows bounded admission. Inspect POST's operation-specific p95 after a change, verify persistence, and repeat from the same dataset. Do not weaken a threshold to hide a regression; revise a budget only when the requirement itself changes.

### 4.2. Stress: gradual high load and recovery

First run the functional verification and the normal 20/s baseline. Then:

```powershell
docker compose run --rm -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_PORT=-1 -e K6_WEB_DASHBOARD_PERIOD=1s -e K6_WEB_DASHBOARD_EXPORT=/results/stress.html k6 run -e TEST_TYPE=stress -e TARGET=read -e CACHE=none --summary-export=/results/stress.json /scripts/load.js
```

The default 4m40s schedule is 30s at 20/s (**baseline**), 60s increasing linearly to 100/s (**ramp_up**), 120s at 100/s (**high**), 10s returning to 20/s (**ramp_down**), then 60s at 20/s (**recovery**). `STRESS_RATE` sets another peak. A successful 100/s run does not discover maximum capacity: it only establishes behaviour at that tested workload.

Observe the first phase where p95, errors, dropped work, CPU or waits deteriorate. Return to the normal rate and compare recovery with the initial baseline. Recovery means normal correctness/latency and resource behaviour return while the API serves requests; a container merely remaining running is insufficient. Do not restart the API between high load and recovery, since that would hide natural recovery behaviour.

**Possible problems and solutions:**

| Signal | Possible solution | What to verify |
| --- | --- | --- |
| API CPU saturated; database still has headroom | Reduce allocation/serialization work, increase CPU or add API replicas | Normal and high-load latency; total DB connection budget |
| Pool waits, SQL waits or write-lock contention increase | Optimize the query/transaction; reduce concurrent database work | Query/lock timings and successful throughput, not just lower error counts |
| Waiting requests keep latency high after the peak | Bound admission and queue length; propagate cancellation/timeouts | Rejections remain visible, and baseline latency returns after pressure drops |
| Dropped iterations appear while generator resources are exhausted | Adjust VUs or separate the generator from the API | Actual sent rate reaches the plan before inferring API limits |

The usual budgets remain active. A nonzero exit under stress is useful evidence, not a reason to disable checks. Record the phase, affected operation and failed budget. If the laptop becomes unusable or no requests make progress, stop with Ctrl+C, record the incomplete run and lower the next peak; do not report an interrupted run as a pass.

### 4.3. Spike: sudden surge and recovery

```powershell
docker compose run --rm -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_PORT=-1 -e K6_WEB_DASHBOARD_PERIOD=1s -e K6_WEB_DASHBOARD_EXPORT=/results/spike.html k6 run -e TEST_TYPE=spike -e TARGET=read -e CACHE=none --summary-export=/results/spike.json /scripts/load.js
```

The default 1m52s schedule is 30s at 20/s, a 1s rise to 200/s, 20s at 200/s, a 1s drop to 20/s, and 60s recovery at 20/s. This is a one-second ramp, not an infinitely instantaneous jump. `SPIKE_RATE` sets another peak. Compare this with the gradual stress run: a spike asks about burst handling, not merely the highest rate sustained for minutes.

Inspect latency, correct/failed responses and dropped work **during the burst**, then how quickly they return to baseline. Repeat the identical spike with `CACHE=memory`, keeping the pre-warm procedure and starting data equal. Test a cold cache separately from a warm one and label the difference.

**Possible problems and solutions:**

| Signal | Possible solution | Cost or limit |
| --- | --- | --- |
| Simultaneous cold misses flood PostgreSQL | Coalesce per-key fills; prewarm a small set of hot pages | Prewarming costs work; a local coalescing lock covers only one API |
| Brief arrival burst fills queues/connections | Bound queues/concurrency, apply rate limits and return clear overload responses | Extra rejections still count as user-visible failures |
| Capacity becomes available only after the burst | Keep capacity headroom or scale before a known event | Reactive autoscaling may be too slow for a short spike |
| Clients retry together and amplify a burst | Limit retries; use backoff/jitter and retry only safe/idempotent operations | This workshop does not retry POST automatically |
| Long recovery after traffic falls | Reduce unbounded backlog; cancel abandoned work | Verify time to recover instead of only an overall percentile |

### 4.4. Soak: stable traffic over time

Verify the setup with a short preview:

```powershell
docker compose run --rm k6 run -e TEST_TYPE=soak -e TARGET=read -e CACHE=memory -e DURATION=2m --summary-export=/results/soak-preview.json /scripts/load.js
```

Then run a separate, genuine two-hour exercise when you can observe it:

```powershell
docker compose run --rm -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_PORT=-1 -e K6_WEB_DASHBOARD_EXPORT=/results/soak.html k6 run -e TEST_TYPE=soak -e TARGET=read -e CACHE=memory --summary-export=/results/soak.json /scripts/load.js
```

Use a rate already demonstrated to be sustainable by the normal-load test. A soak is not continuous overload. The two-minute preview and a passing two-hour aggregate p95 do not prove stability over an entire school day; choose duration from the risk, including expiry cycles, scheduled work and data growth.

Keep another terminal open for `docker compose stats` and sample `/api/stats` and database activity at recorded intervals. Record CPU/memory, query deltas, cache hit rate and latency near the start, middle and end; snapshots at startup and shutdown alone can miss drift. Memory growth that settles after warm-up can be normal. Sustained growth with increasing tail latency deserves investigation; inspect managed heap/GC and retained objects before claiming a leak.

**Possible problems and solutions:**

| Signal | Possible solution | What to verify |
| --- | --- | --- |
| Memory keeps growing instead of stabilizing | Inspect retention; bound caches/collections; release owned resources | Heap/resource trend and latency over another complete soak |
| Connections or readers remain busy longer over time | Dispose readers/connections and shorten transaction lifetime | Active connections, pool waiting and recovery after work ends |
| Periodic latency jumps align with expiry | Coalesce fills or spread different keys' expiries | Peaks shrink without violating freshness requirements |
| Storage and POST latency grow together | Plan retention and storage capacity; inspect index/WAL/vacuum behaviour | Equivalent data growth and write cost; do not delete data required by the product |
| k6 resources grow while the API remains stable | Inspect generator metrics/output volume; reduce expensive output or isolate the generator | Distinguish generator degradation from application degradation |

Start with GET so the dataset stays stable. A two-hour 20/s write-only test plans about **144,000 inserts**; mixed traffic plans about 14,400 writes, plus any warm-up. Use `ALLOW_WRITES=true` deliberately and report growth. Old-generation cache entries can accumulate until expiry, so include mixed writes only as a separately defined soak workload.

### 4.5. Compare phases and report evidence

The script tags requests by `test_type`, `operation` and `phase`. Stress/spike phases are `baseline`, `ramp_up`, `high`, `ramp_down` and `recovery`; load/soak use `steady`. A phase tag reflects when the request **started**, so a slow request can finish in a later phase. Phase-specific latency and incorrect-response metrics appear in the summary; recovery has its own latency/correctness thresholds. Global budgets still include the high-load phases.

For trends, use the exported [k6 HTML dashboard](https://grafana.com/docs/k6/latest/results-output/web-dashboard/) alongside timed server observations. The Docker `-e K6_...` options appear **before** the service name `k6`, while script settings such as `-e TEST_TYPE=...` appear after `k6 run`. The dashboard exports without opening a listening port. Its aggregation windows can blur a one-second edge; do not infer individual-request timing from the smoothed curve.

An aggregate p95 can hide a short bad spike or late degradation. For load/soak, planned requests are `rate × duration`. For ramped profiles, sum each stage's area: `seconds × (start rate + end rate) / 2`, including plateaus and recovery. Compare approximate planned counts, actual sent/completed work, dropped/interrupted iterations and phase results.

| Test | Cache / operation | Rates and timings | First degradation / phase | Peak latency / errors / dropped | Recovery or time trend | Resource evidence | Proposed change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Load | | | | | Steady baseline | | |
| Stress | | | | | Return to baseline? | | |
| Spike | | | | | Time to recover? | | |
| Soak | | | | | Start / middle / end | | |

**Checkpoint:** justify the test type for a predictable morning login period, a sudden notification to all parents, and performance that degrades after several hours. Explain what a passing normal-load test leaves untested. For each observed problem, propose one solution and the repeatable test that could verify it.

## 5. Compare no cache and API memory

Keep workload, data, warm-up, resources and duration equal. Close the browser and avoid writes during measurements. Warm each mode at 1/s for 15 seconds, then measure it twice at 20/s. For memory:

```powershell
docker compose run --rm k6 run -e TARGET=read -e CACHE=memory -e RATE=1 -e DURATION=15s /scripts/load.js
Invoke-RestMethod http://localhost:53120/api/stats
docker compose run --rm k6 run -e TARGET=read -e CACHE=memory -e RATE=20 -e DURATION=60s --summary-export=/results/read-memory-1.json /scripts/load.js
Invoke-RestMethod http://localhost:53120/api/stats
```

Repeat with a distinct report filename for the second memory run. Repeat `CACHE=none` for a fresh baseline. The default TTL is **30 seconds**; a 60-second run includes expiry/refilling. Reverse mode order in the second comparison to detect order/warm-up effects.

Inspect headers manually:

```powershell
$r = Invoke-WebRequest 'http://localhost:53120/api/lessons?language=nl&page=1&pageSize=20&cache=memory'
$r.Headers
```

`X-Cache` reports `BYPASS`, `MISS` or `HIT`. `X-Instance` identifies the API container; `X-Data-Version` and `X-Cache-Key` expose freshness/key choices. The implementation uses **cache-aside**: check cache, query on miss, fill with an absolute TTL. Memory holds at most 1,000 entries, each with an absolute expiry time. Both expiry and eviction cause misses.

Keys include schema version, public access scope, language, catalogue generation, page and page size. Change page or language and inspect the key and body. Omitting these distinctions can return the wrong records.

**Every list GET still queries the current generation in PostgreSQL**, including cache hits. The cache removes list-query work and DTO construction, not all database traffic, response serialization or network transfer. This consistency trade-off keeps invalidation consistent across API copies. An indexed list may already be fast; cache bookkeeping may add more work than it removes. Reduced database work and reduced latency are separate claims.

Broaden the working set with `-e PAGES=100` on **all** compared runs. More distinct pages may lower the hit rate. Do not compare a 100-page workload with a one-page baseline as proof of a cache improvement.

**Checkpoint:** draw hit/miss paths and compare counter deltas. Why does this design still need PostgreSQL on a cache hit?

### Possible problems and solutions: cache effectiveness

- **Low hit rate:** inspect distinct keys, write frequency and TTL. Cache the repeatedly read pages, reduce unnecessary key variation, or increase TTL only if acceptable freshness allows it. Do not combine languages, pages or access scopes just to increase hits.
- **Hits save list queries but barely change latency:** measure the generation query, response bytes and serialization. A summary DTO may help; a cheaper/coalesced freshness check is another design option, but caching that generation introduces a staleness window.
- **Cache overhead outweighs the indexed query:** leave caching disabled for that workload. Compare repeated measurements rather than assuming every cache improves performance.
- **Memory or eviction churn:** retain a size limit, restrict admitted keys and tune entry count/TTL from observed memory use. Increase memory only if the resource budget permits it. Size here is an entry count, not a measured byte limit.

## 6. Check POST invalidation and expiry

Warm an NL list with `cache=memory`. POST a distinctive title, then GET the same list immediately. The new record should be first and the version should increase. `verify.js` automates this.

The POST transaction inserts the row **and** increments the database generation. New GETs use new keys. Old entries remain until expiry/eviction: logical invalidation rather than synchronous deletion. A GET that read an old generation before a concurrent POST committed can finish with that earlier view. A request started after the completed POST observes the new generation.

Expiry refills an unchanged generation after its TTL:

```powershell
docker compose run --rm k6 run -e CHECK_TTL=true -e TTL_WAIT_SECONDS=31 /scripts/verify.js
```

This assumes the default 30-second TTL. For a quicker demo set `$env:CACHE_TTL_SECONDS = '5'`, run `docker compose up -d --force-recreate api`, and verify with `TTL_WAIT_SECONDS=6`. Restore defaults with `Remove-Item Env:CACHE_TTL_SECONDS` and recreate the API.

**Discussion:** a future edit route must increment the generation inside its transaction. Direct SQL edits bypass that rule and can stay stale until expiry. A generation per language reduces unrelated invalidation but changes implementation and write contention.

### Possible problems and solutions: freshness and refilling

| Observation / evidence | Possible solution | Cost or limit |
| --- | --- | --- |
| A new POST is missing from a cached list | Invalidate/version affected lists after a successful transaction | The supplied transaction already advances the generation; any future edit/delete path must follow the same rule |
| Changes in FR invalidate unrelated NL pages | Use a generation per language, and per access scope where necessary | More bookkeeping; every affected scope must advance correctly |
| Old generation entries occupy memory | Use bounded storage and expiry; consider explicit removal when practical | Logical invalidation guarantees freshness but does not immediately reclaim every old entry |
| Many requests miss together after expiry | Coalesce concurrent fills for the same key and recheck the cache after acquiring the key's lock | A local lock only coordinates one API; avoid an unbounded dictionary of locks |
| Many different keys expire together | Spread expiry with a small random offset or refresh selected hot keys early | Jitter spreads bursts; it does not stop several fills of one key or extend a strict freshness deadline |

The essential request-coalescing algorithm is: **check cache → acquire the key's lock → check again → query and fill if still missing → release**. The second check is necessary because another request may already have filled the entry. The existing global semaphore only limits active list queries; it does not coalesce requests. [HybridCache](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0) can provide in-process caching with stampede protection without configuring an external cache; adopting it is an optional extension.

## 7. Observe two API copies with independent memory caches

```powershell
docker compose --profile scale up -d --build --wait
docker compose run --rm k6 run -e SECOND_URL=http://api2:53120 /scripts/verify.js
```

API 2 is at **http://localhost:53121**. Both copies share PostgreSQL, but each owns its memory cache. Verification creates a new generation, warms API 1, then checks MISS followed by HIT on API 2. A POST must become visible on both copies because they read the database generation. `X-Instance` identifies the container. There is no load balancer: this demonstrates cache independence, not a throughput scaling benchmark.

Active list work is limited to 16 executions and database connections to 20 **per API**. Queued requests still wait. The current code has no rate limiter, bounded request queue or per-key request coalescing. Both instances still need PostgreSQL even on cache hits.

**Possible problems and solutions:**

| Observation / evidence | Possible solution | Cost or limit |
| --- | --- | --- |
| API CPU is saturated, while PostgreSQL has headroom | Increase API CPU, or add replicas behind a load balancer | Measure again; each replica has its own cache and adds database connections |
| Both APIs wait on the same slow query or write lock | Improve that SQL/transaction before adding replicas | Extra replicas can increase database pressure |
| New/restarted replicas have many cold misses | Prewarm a small set of popular keys, or gradually send traffic to the replica | Prewarming also costs database work; avoid warming the entire catalogue |
| Pool waits increase after adding API copies | Budget total connections across all replicas and tune concurrency to database capacity | Raising every pool limit can overwhelm PostgreSQL |
| Requests accumulate while all list slots are busy | Bound concurrent requests and queue length; reject excess work explicitly | A `429` is a visible rejection, not a successful fast request |
| PostgreSQL is unavailable | Return a controlled failure and restore database availability; consider stale public data only if requirements allow it | This demo's generation lookup prevents serving cached lists during a database outage |

For example, a possible concurrency policy could use the built-in [ASP.NET Core limiter](https://learn.microsoft.com/en-us/aspnet/core/performance/rate-limit?view=aspnetcore-10.0):

```csharp
builder.Services.AddRateLimiter(o => {
    o.RejectionStatusCode = 429;
    o.AddConcurrencyLimiter("lists", p => {
        p.PermitLimit = 16;
        p.QueueLimit = 0;
    });
});
// After Build(), before endpoint execution:
app.UseRateLimiter();
// On the existing list endpoint:
// .RequireRateLimiting("lists")
```

This illustrative snippet needs `using Microsoft.AspNetCore.RateLimiting;`. It is not enabled in the provided API. A concurrency limit bounds in-flight requests, not requests per second. Its budget applies separately to each API copy; choose values from measurements rather than assuming these classroom values fit production.

**Checkpoint:** what happens to the maximum total database connections with ten API copies? What evidence would justify adding an API replica?

## 8. Observe browser and frontend caches

Open the demo and DevTools **Network**, with no load test and no throttling.

1. Leave frontend caching off. Click **Load lessons** twice with API cache `none`: both actions call GET. Choose `memory` and repeat: requests still occur, but the API can report HIT.
2. Enable **Frontend data cache**. Click twice within 10 seconds: the second action sends no GET. Wait beyond 10 seconds and retry. **Refresh from API** bypasses the frontend Map but preserves the selected server-cache mode.
3. Create a lesson. On successful POST the page clears its Map and reloads. Create from another tab: this tab can retain stale data for up to 10 seconds. The API cannot invalidate an already loaded Map in another browser.
4. Inspect `app.v1.js`. Its header is `public,max-age=31536000,immutable`. With **Disable cache** unchecked, navigate away and return normally to observe browser reuse. Hard reload may deliberately revalidate. HTML uses `no-cache`; API responses use `no-store`, so API data caching here is explicit in JavaScript/server code.
5. Explain why a script change requires a new versioned URL. In deployment, use content hashes rather than replacing an immutable file's contents.

Compare the same browser POST under **No throttling**, then a recorded slow network preset. Keep payload size and CPU settings fixed. Observe saving feedback, disabled submission and draft retention on failure. Next generate background API traffic:

```powershell
docker compose run --rm k6 run -e TARGET=read -e CACHE=none -e RATE=50 -e DURATION=120s /scripts/load.js
```

Repeat the browser action with the same slow network settings. Record status, duration and usability. DevTools throttling affects that browser, **not** k6. Browser POSTs change generations and add traffic: keep this separate from controlled cache benchmarks. Try CPU throttling separately with normal network settings, then restore both.

**CDN discussion:** place a CDN before versioned public assets. Which transfers disappear, and which API calls still occur? Why must private class responses not become public shared cache entries? This local stack cannot measure geographic edge latency.

### Possible problems and solutions: browser experience

| Observation / evidence | Possible solution | Verify afterward |
| --- | --- | --- |
| Repeated GETs with unchanged filters | Reuse frontend data with an explicit freshness rule; debounce search and cancel obsolete fetches | Count actual Network requests and check final displayed data |
| Another tab still shows old records | Provide explicit refresh, shorter TTL, or cross-tab change notification | This page already clears its Map after its own POST; other tabs need a separate mechanism |
| Slow network dominates small requests | Avoid redundant calls; keep assets cacheable and reduce request round trips | Compare the same interaction/profile; extra server CPU may not help |
| Large responses dominate transfer | Use a smaller summary DTO, bounded pages, or HTTP compression | Measure bytes and CPU cost; compression is not implemented in this sample |
| High browser CPU delays clicks/rendering | Render fewer records, defer expensive components, break up long tasks or move CPU-heavy work to a worker | Compare Performance traces under the same CPU setting |
| Large public assets are slow far from origin | Use optimized/versioned assets and consider a CDN | Measure from relevant user locations; localhost cannot prove an edge benefit |
| Repeated submissions while saving | Disable duplicate submission, retain drafts, and add server idempotency for safe retries | The page disables its controls; the server idempotency extension is still required for retry safety |

For a future search box, the essential debounce is:

```javascript
clearTimeout(searchTimer);
searchTimer = setTimeout(() => search(currentQuery), 250);
```

Declare the timer outside the handler. Capture the intended query and cancel or ignore obsolete in-flight responses as well; debounce alone cannot prevent an old response replacing a newer result. The sample has no search endpoint, so this is an illustration rather than an added feature.

## 9. Report a fair comparison

Keep machine, resource limits, build, seed data, language, page range/size, rate, duration, VUs and warm-up equal. Run tests sequentially; stop API 2 for single-instance comparisons. Repeat at least twice.

| Run / operation / cache | Rate / seconds | Planned / sent / completed | p50 / p95 / p99 | HTTP / contract failure % | Dropped | Cache hit % | List / version query delta | CPU / memory / waits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET baseline 1 / none | | | | | | | | |
| GET baseline 2 / none | | | | | | | | |
| GET / memory | | | | | | | | |
| POST baseline | | | | | | N/A | | |
| Higher load, same operation | | | | | | | | |

For controlled write comparisons restore the same starting state each time: every warm-up and POST run adds rows. In this disposable stack, `docker compose --profile scale down -v` deletes the workshop volume; `docker compose up -d --build --wait` recreates seed data. It also resets caches/counters. Repeat identical warm-up afterward.

Submit the comparison tables, k6 reports, server observations, one freshness proof, one two-instance cache proof and a short conclusion. Label each test type and distinguish a soak preview from a genuine prolonged run. Identify work removed, measured benefit, costs and limits. A localhost test sharing CPU between generator, API and database does not establish production capacity.

### Possible problems and solutions: misleading measurements

If results vary strongly, repeat sequentially with fixed data/resources and isolate generator contention. If short runs produce unstable tails, extend duration and collect more samples. Separate cold-start, warm steady-state and overload experiments. Preserve failed/wrong responses and dropped iterations in the report instead of reporting only the faster successful requests. A change is justified by repeatable evidence at the same workload, not by one lower p95.

## Optional experiments

**Mixed reads/writes:** use `TARGET=mixed`, `ALLOW_WRITES=true`, `CACHE=memory`. Approximately 90% GET / 10% POST, one request per iteration. Compare with the same mixed workload using `CACHE=none`. Operation-specific latency thresholds remain separate. Writes advance the generation and can reduce hit rate. An aggregate percentile is neither the GET nor POST percentile. **Possible solution if hits collapse:** narrow invalidation to changed languages or avoid caching pages that change constantly; measure POST contention as well as GET latency.

**Artificial list cost:** set `$env:DEMO_QUERY_DELAY_MS = '50'` and recreate the API. This adds a labelled async delay only on list execution, including cache misses. Keep it identical across comparisons. It demonstrates avoided work, not measured PostgreSQL latency. Remove the variable and recreate the API before real measurements. **Possible solution for a genuinely slow dependency:** optimize its measured work, bound calls/timeouts, or cache reusable results; removing an artificial delay is not an optimization of a real database.

**Cache stampede:** let a popular entry expire under load. Multiple misses can query together; this simple implementation has no per-key single-flight lock. Inspect list-query deltas around expiry. Use the coalescing/jitter options in section 6 and discuss cross-instance coordination. ASP.NET Core also offers [output caching with default resource locking](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output?view=aspnetcore-10.0); HTTP output caching is another layer and is not enabled here.

**Query plan:** use `docker compose exec db psql -U workshop -d workshop -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id, language, title, content, created_at FROM lessons WHERE language = 'nl' ORDER BY id DESC LIMIT 20;"`. Explain what the index and SQL pagination save before introducing a cache. If the plan does excessive work, investigate index/filter/order alignment and stale statistics; compare plans before changing indexes that also affect POST cost.

## Troubleshooting and cleanup

| Symptom | Check |
| --- | --- |
| Port 53120/53121 occupied | Stop the conflicting service or change the published port; internal k6 URLs still use 53120 |
| Connection refused at startup | Retry health; inspect `docker compose ps` and `docker compose logs api db` |
| k6 cannot connect | Docker uses `http://api:53120`, not localhost; override with `-e BASE_URL=...` after `k6 run` |
| SQL seed changed but database did not | Initialization needs a new disposable volume |
| Repeated MISS | Check TTL, generation changes, key, API instance and eviction |
| Nonzero load-test exit | Find the failed latency/error/drop threshold |
| TTL test fails | Match wait time to configured TTL plus a margin; avoid other requests |

Stop while retaining PostgreSQL data:

```powershell
docker compose --profile scale down
```

Add `-v` only for a destructive **workshop-only reset**. Reports in `results/` remain. The Compose project name is `psr-workshop`; avoid running multiple copies with that name on one engine. Major image tags receive updates: pre-pull/test before a classroom session and record image digests with measurements.
