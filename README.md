# Performance testing with Docker and k6

This project has a small API that stores lessons. Use **GET** to read lessons and **POST** to add one. Docker starts the API and PostgreSQL. It also runs the k6 tests.

You need Docker Desktop, Git and a browser. Run these commands in PowerShell:

```powershell
git clone https://github.com/mcloots/swe_performance.git
cd swe_performance
docker compose up -d --build --wait
Invoke-RestMethod http://localhost:53120/api/health
docker compose run --rm k6 run /scripts/verify.js
```

The health request should return `ready`. If the API is still starting, try again. All k6 checks should pass.

Open **http://localhost:53120** for the demo page. The database starts with 30,000 test lessons in Dutch, French and German. There is no login; use test data only.

## Run a test

Read lessons at 20 requests per second:

```powershell
docker compose run --rm k6 run -e TARGET=read -e RATE=20 -e DURATION=60s /scripts/load.js
```

Add lessons at 20 requests per second:

```powershell
docker compose run --rm k6 run -e TARGET=write -e ALLOW_WRITES=true -e RATE=20 -e DURATION=60s /scripts/load.js
```

The POST test adds records to the database.

| Test setting | What it tests |
| --- | --- |
| `TEST_TYPE=load` | Normal traffic |
| `TEST_TYPE=stress` | Slowly increase traffic above normal |
| `TEST_TYPE=spike` | Send a sudden burst of traffic |
| `TEST_TYPE=soak` | Keep sending normal traffic for a long time |

Add one of these settings after `k6 run`. Load is the default. Soak runs for two hours unless you set `DURATION`. Stress and spike use stages in `k6/profiles.js`.

## Try caching

A cache keeps data so it can be reused:

- Add `-e CACHE=memory` to use the API's saved lesson pages. The default is `CACHE=none`.
- On the demo page, enable **Frontend data cache** to reuse data without another API request.
- The browser can also keep the JavaScript file `app.v1.js` instead of downloading it again.

### In Angular

In an Angular project, run `ng build --configuration production --output-hashing=all`. Angular puts a hash in bundle filenames. Changed code gets a new filename.

Set long browser cache headers for these public hashed files. Set `Cache-Control: no-cache` for `index.html` so the browser checks for an updated page. The webserver sets these headers, not an Angular component. See [Angular build options](https://angular.dev/cli/build).

Keeping API data in an Angular service is a separate cache. Refresh that data after a change. An optional service worker adds another cache; it is not enabled in this demo.

## Stop or reset

Stop and keep the database:

```powershell
docker compose --profile scale down
```

Add `-v` to that command only if you want to delete the workshop database. The next start creates the original test records again.
