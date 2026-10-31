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

Docker is unavailable in the implementation environment. Container build/health/non-root/HTTP smoke are configured as a distinct GitHub Actions job; no local image-build result or new remote CI pass is claimed. `scripts/http-smoke.mjs` runs four actual HTTP cases against an owned instance: normal completion, cooperative abort, naive continuation, and noncooperative continuation, verifying post-close resource inventories. Existing CLI evidence remains separate from this application check.
