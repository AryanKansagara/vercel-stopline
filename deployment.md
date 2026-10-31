# StopLine deployment contract

This repository now includes a runnable Node HTTP application and same-origin interface. Live hosting, Vercel request-cancellation behavior, reverse-proxy behavior and vendor inference/billing remain unverified. Every experiment uses the actual local HTTP lab and an authored generator. There is no external provider address, credential, model or bill.

## Start and verify

Use Node 24 (supported LTS line), no npm installation or packages:

```sh
npm test
PORT=3000 npm start
# In another terminal, against this instance only:
BASE_URL=http://127.0.0.1:3000 npm run smoke
```

`npm run dev` uses `dev.mjs` to start the same server and accepts preview arguments `--host 0.0.0.0 --port 4173 --strictPort`. It always fails if the chosen port is occupied. The production start command uses `PORT` for the application listener; default 3000, bind `0.0.0.0`. Port zero is accepted for local process tests and the startup JSON prints the selected loopback URL. The two internal lab servers always use fresh ephemeral loopback ports. Send SIGTERM/SIGINT to stop admission, force remaining experiments to settle, close application sockets and stop the listener. The production command is `node server.mjs`, without a watch process or build step.

`GET /healthz` indicates the HTTP process is reachable. `GET /readyz` returns 200 with `{ready:true,activeJobs,retainedJobs}` when accepting requests and `web/index.html` is a regular file inside the real static boundary, within the 2 MiB ceiling; unavailable assets/shutdown return 503. No secret or absolute file path is exposed by errors.

## Same-origin API

POST `/api/runs` with Content-Type `application/json` (optional `charset=utf-8`). Exactly these five fields are required; unknown/missing fields, strings for numbers, unsupported values and invalid JSON are rejected:

```json
{"policy":"propagate","providerBehavior":"cooperative","totalUnits":12,"intervalMs":25,"initialDelayMs":50}
```

| Field | Allowed |
| --- | --- |
| policy | `naive`, `propagate` |
| providerBehavior | `cooperative`, `noncooperative` |
| totalUnits | integer 1–60 |
| intervalMs | integer 10–150 |
| initialDelayMs | integer 0–500 |

Response 201: `{id,streamUrl,statusUrl}`, where the two URLs are relative same-origin paths. GET `streamUrl` exactly once to start. The actual response is `text/plain; charset=utf-8`: lines `1:xxxxxxxx...\n`, with a numbered unit and 32 fixture `x` characters. This is not NDJSON. Read chunks with a streaming UTF-8 decoder, preserving incomplete lines. `AbortController.abort()` on that fetch closes the public relay socket; the relay destroys its real outgoing HTTP request to the lab proxy, which applies the selected abort policy to its own provider request. There is no cancel endpoint or synthetic provider-cancel counter.

GET `statusUrl` to poll `{id,status,terminal,configuration,metrics,events,cleanup,error,createdAt,cleanupForced,notice}`. Events are actual lab records `{sequence,atMs,kind,provenance:"observed",unit?}`. Metrics are `null` before initialization, otherwise a live lab snapshot; fields include `providerUnits`, `providerUnitsAfterCancel`, `propagatedAborts`, `providerCancellationObserved`, `clientCancelAtMs`, `activeTimers`, `activeProviderJobs`, `activeProxyRequests`, `openSockets`, and `listeningServers`.

| Status | Meaning |
| --- | --- |
| queued | Reserved a slot; stream not opened |
| running | Initializing or streaming actual HTTP |
| settling | Client ended/disconnected; awaiting real work settlement and server cleanup |
| completed | Full stream completed and resources settled |
| cancelled | Public client disconnected and resources settled |
| expired | Unopened job expired |
| timeout | Absolute job deadline forced cleanup |
| failed | Startup, upstream or resource error |
| shutdown | Server shutdown forced cleanup |

Poll until `terminal:true`. `cancelled` does not imply the provider stopped early: inspect actual work and events. In the naive and noncooperative controls, settling continues while scheduled generator work actually completes. `cleanup` is a post-close snapshot, or null if no lab was started; terminal lab runs have zero tracked timers, provider jobs, proxy requests, sockets and listening lab servers. Public listener sockets are separately owned by the server and remain available for polling.

`cleanupForced:true` identifies administrative cleanup (deadline/shutdown/expiry/startup cleanup). Such outcomes do not establish policy efficacy, even if shutdown records a provider cancellation. `error` contains safe fixed text, never internal addresses or exception dumps. Error responses are `{error:string}` with 400 schema/JSON, 403 foreign Origin, 404 missing/evicted ID, 405 method, 409 stream already claimed, 413 body size, 415 content type, 429 limits, 503 unavailable/admission stopped. A slow body receives a bounded 408/closed connection.

## Resource and retention limits

- Two active slots per process, including queued/running/settling jobs. Capacity is rechecked after asynchronous body parsing, preventing simultaneous POSTs from exceeding it.
- An instance-wide token bucket allows 12 creation attempts per minute (initial burst 12). Malformed creations also consume tokens. There is no per-user fairness or distributed rate limiter.
- At most 8,192 body bytes and 8,192 header bytes; request-body deadline two seconds, Node headers/request timeout five seconds. Chunked and Content-Length bodies are both bounded.
- Unopened jobs expire five seconds after POST. All jobs have an absolute 12-second deadline from POST, including time spent queued. Opening very late can leave too little time for a maximum-length run and produce timeout; choose smaller examples or open immediately.
- At most 20 retained results. Terminal results expire after 60 seconds and are lazily removed on later API/static requests. Oldest terminal records can be evicted earlier under the cap; active records are never evicted. Results are in-memory and disappear on process restart.
- Static serving is limited to real regular files under `web/`, with supported extensions and a 2 MiB ceiling, excluding traversal and symlink escapes. No arbitrary source file/directory browsing or external fetch destination exists. CSP permits same-origin scripts/styles/connects and rejects inline scripts and frames.

This is one process with in-memory job IDs and no public account system. Host a single replica or use sticky routing; polling another replica cannot recover a job. For an internet launch, place it behind an ingress with TLS, response buffering disabled, streaming support, connection/rate limits and a request timeout exceeding the 12-second job lifetime. Validate actual disconnect propagation through that ingress. The global slot/rate limit is deliberately shared and can reject traffic during a demonstration; it is not a multi-tenant service or authentication boundary. No hosting is enabled by these files.

## Container

```sh
docker build -t stopline .
docker run --rm --name stopline -p 127.0.0.1:3000:3000 stopline
# Another terminal:
BASE_URL=http://127.0.0.1:3000 node scripts/http-smoke.mjs
```

The Dockerfile uses official `node:24-bookworm-slim`, runs as existing non-root `node`, copies only runtime files/assets, exposes port 3000, and probes `/readyz` with a Node-based HEALTHCHECK. No package download, shell entrypoint or root runtime is needed. Set a fixed nonzero PORT for container HEALTHCHECK; PORT=0 is for the host-side test entrypoint. The floating 24 tag intentionally tracks supported-line patches; it is not a reproducible digest pin. Resolve and pin an approved digest in your deployment release process.

The official Node image and supported Node 24 release line were checked against primary sources on 2026-10-31:

- https://hub.docker.com/_/node
- https://github.com/nodejs/docker-node
- https://nodejs.org/en/download

Docker is unavailable in the implementation environment. The earlier application publication at remote `ec8dfc2` passed the Docker build/HTTP smoke/health/non-root checks in [GitHub Actions run 41245698790](https://github.com/AryanKansagara/vercel-stopline/actions/runs/41245698790). That evidence does not validate Railway or Vercel hosting, and subsequent configuration changes need their own CI run. `scripts/http-smoke.mjs` runs four actual HTTP cases against an owned instance: normal completion, cooperative abort, naive continuation, and noncooperative continuation, verifying post-close resource inventories. Existing CLI evidence remains separate from this application check.


## Vercel static frontend and Railway backend

`railway.json` selects the repository Dockerfile, `/readyz`, one replica, bounded failure restarts, zero rollout overlap and a 15-second SIGTERM drain allowance. Configure Railway from the repository root; keep its assigned `PORT`, use one region/replica, and leave the Dockerfile start command intact. Jobs live only in process memory: deployment cutover/restart can interrupt an active experiment or discard its result. No volume or external database is required. Railway's deployment healthcheck gates startup; it does not establish browser disconnect propagation or continuous monitoring.

Set Railway `PUBLIC_ORIGIN` to the **actual canonical HTTPS origin of the Vercel frontend**. It is optional for direct same-origin hosting, but a mismatching proxied browser Origin is rejected when it is absent. Examples in test fixtures are not deployment addresses. The backend validates this value before opening any listener. It must be one HTTPS origin: no trailing slash, credentials, path, query, fragment, comma-separated list, wildcard, implicit normalization or default `:443` suffix. Exact Origin comparison permits only this configured origin in addition to the request's direct HTTP/HTTPS Host. `Forwarded`, `X-Forwarded-Host` and `X-Forwarded-Proto` never expand the allowlist. Requests without Origin (CLI/server clients) still work. This is request-origin checking, not authentication or a CORS gateway; no wildcard/access-control response headers or preflight bypass are added.

On Vercel, set `BACKEND_ORIGIN` to the **actual deployed canonical HTTPS Railway origin**, then deploy from the repository root with its programmatic `vercel.ts`. Missing or invalid backend origin fails configuration loading. Its build command copies only six public frontend assets (including the theme stylesheet/controller) into `dist`; server code, tests and reports are excluded. Vercel serves those assets and rewrites `/api/:path*`, `/healthz`, and `/readyz` to the configured backend while preserving their paths. The browser keeps relative API URLs and its real streaming fetch/AbortController; no browser-visible backend address, mock response or static-only success fallback replaces it. Do not commit a guessed backend URL or add a competing `vercel.json`.

The rewrite uses no response-body adapter. Keep the backend's streaming headers (`text/plain`, `no-store, no-transform`, `X-Accel-Buffering: no`) and Vercel's no-store response configuration; do not enable external-origin CDN caching for job/status/stream routes. These choices express streaming intent, **not evidence that an external proxy forwards disconnects**. After both real hosts are connected, run the four-case HTTP smoke against the direct backend and Vercel origin, then verify in a real browser that units arrive incrementally, AbortController cancellation produces observed provider events, both continuation controls remain distinct, and final resource counts settle. Check header/Origin behavior on the exact production domain: a different Vercel preview URL is not implicitly trusted. If either ingress buffers or keeps the origin request alive after disconnect, report that behavior as unverified/failed and correct the routing before claiming cancellation propagation.

These files prepare the split-host topology; account connections, domains, deployed URLs and public-host streaming validation remain pending. No service has been created by this configuration change.

Primary configuration references checked on 2026-10-31:

- https://docs.railway.com/config-as-code/reference
- https://railway.com/railway.schema.json
- https://docs.railway.com/deployments/healthchecks
- https://vercel.com/docs/project-configuration/vercel-ts
- https://vercel.com/docs/routing/rewrites
