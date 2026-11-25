# Workshop: performance testing and caching with Docker and k6

Test a standalone lesson catalogue with **GET records** and **POST records**. Docker Compose runs PostgreSQL, a .NET 10 API and k6. Distinguish load, stress, spike and soak testing; compare latency, correctness, resources and caching, then check freshness and independent API caches.

Commands below run from this repository's root, containing `compose.yaml`, using PowerShell. Docker Desktop with Linux containers and a browser are sufficient. You need no local SDK, Node.js, PostgreSQL or k6. The first build needs internet access.

## Learning goals and course connection

Choose a test type from the risk you want to investigate. Define a workload, distinguish request rate from virtual users, interpret p50/p95/p99, validate responses, and assess caching using server evidence. Explain cache keys, expiry, invalidation, access scope and recovery behaviour.

| Course layer | Implementation | Work avoided on a hit |
| --- | --- | --- |
| Browser HTTP cache | Immutable `app.v1.js`; Angular uses hashed bundles plus hosting cache headers | Downloading the same JavaScript/CSS |
| Frontend data cache | Optional 10-second JavaScript Map | Repeating an API request |
| API memory | `IMemoryCache`, `cache=memory` | Executing the list query in one API copy |
| CDN / edge | Discussion exercise; no external CDN deployed | Transferring public files from a distant origin |

### Browser HTTP caching in Angular

In an Angular project, `ng build --configuration production --output-hashing=all` creates versioned bundles. Configure hosting to send `Cache-Control: public, max-age=31536000, immutable` for public hashed bundles and `Cache-Control: no-cache` for `index.html`. Check emitted filenames before applying immutable headers to copied assets. Angular creates the hashes; the webserver sets headers; the browser caches files. See [Angular build options](https://angular.dev/cli/build).

`HttpClient` data sharing in an Angular service needs separate expiry/invalidation rules. An optional Angular service worker adds another cache layer through `assetGroups`/`dataGroups`; inspect Cache Storage separately from the HTTP cache. See [Angular service-worker configuration](https://angular.dev/ecosystem/service-workers/config). The supplied demo uses plain JavaScript and has no Angular service worker.

Records are **public synthetic lessons**, in NL/FR/DE. There is no authentication or class authorization. A private catalogue must authorize each request and scope its keys appropriately; a key containing `scope-public` does not implement permissions.

Each exercise includes **possible problems and solutions**: first identify the signal, then choose one change and repeat the same workload. Proposed solutions and snippets are discussion material; only behaviour explicitly described as implemented exists in the supplied API. Snippets show the essential change and may require surrounding types/configuration.

## Start and verify the stack

Clone the workshop repository and open its root. If you already cloned it, open that directory and skip the first two commands:

```powershell
git clone https://github.com/mcloots/swe_performance.git
cd swe_performance
docker compose up -d --build --wait
Invoke-RestMethod http://localhost:53120/api/health
docker compose run --rm k6 run /scripts/verify.js
```

Wait for health to return `status: ready`; retry it if the API is still starting. Compose checks PostgreSQL health; the API has no container health probe. `verify.js` checks contracts, cache hits, language/page separation and invalidation after POST. It adds two fixture rows. Fix failed checks before measuring load.

```

Add `-v` only for a destructive **workshop-only reset**. Reports in `results/` remain. The Compose project name is `psr-workshop`; avoid running multiple copies with that name on one engine. Major image tags receive updates: pre-pull/test before a classroom session and record image digests with measurements.
