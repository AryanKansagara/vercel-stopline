# Deployment and API

## Runtime and durable storage

Use official `node:24-bookworm-slim`, one Railway Docker replica, the repository `Dockerfile`, assigned `PORT`, and `/readyz` healthcheck. `railway.json` has zero rollout overlap: **never run two processes against this SQLite directory**. Attach a durable volume at `/data` and configure:

```text
DATA_DIR=/data/stopline
RAILWAY_RUN_UID=0
DROP_PRIVILEGES=1
PUBLIC_ORIGIN=https://vercel-stopline.vercel.app
```

Railway mounts can initially be root-owned. `launch.mjs` refuses to serve HTTP as root without explicit privilege-drop configuration. It opens directories with `O_DIRECTORY|O_NOFOLLOW`, rejects symlinks, gives `/data` traverse permission 0711 and initializes only the configured DATA_DIR itself (0700, UID/GID1000); existing intermediate directories are checked but not chowned, without recursively changing user files. It clears supplementary groups and sets GID/UID1000 **before importing the server**. Any failure exits closed. The default Docker image remains `USER node`; its precreated `/data/stopline` needs no elevated startup without a volume. Configured unwritable, symlinked or invalid storage fails startup; there is no temporary-directory fallback. `/readyz` cannot pass if database initialization failed. Local development uses `npm run dev`, not the production root-refusing launch wrapper.

SQLite uses foreign keys, prepared statements, WAL, secure_delete, a 32768-page ceiling at 4096-byte pages (~128 MiB), a 128-page auto-checkpoint and an 8 MiB retained-journal target. No long-lived read transactions are kept. The journal target is a post-checkpoint target, not an independent hard instantaneous filesystem quota. Reserve a volume larger than the database plus WAL/SQLite overhead. Deletions remove logical records and secure_delete overwrites freed database content; this is not a guarantee about host snapshots or forensic erasure. Set a hosting volume quota as a second bound. Capacity exhaustion returns 507 where detected, blocks new persistence and terminates affected runs safely. Back up/restore the directory only using a SQLite-aware procedure or stopped service.

On restart unfinished saved runs become terminal `interrupted`; completed history and workspace token hashes survive. In-flight streams cannot resume. Shutdown stops admission, awaits pending DNS validation, closes actual upstream requests/timers and the HTTP server, checkpoints and closes SQLite. Preserve the volume across releases.

## Container validation

```sh
docker build -t stopline .
docker run --rm --name stopline --tmpfs /data/stopline:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700 -p 127.0.0.1:3000:3000 stopline
# In another terminal:
node scripts/http-smoke.mjs
node scripts/product-smoke.mjs
```

The tmpfs is disposable CI storage, not the production persistence configuration. For durable local Docker testing mount an appropriately owned named volume. CI checks the real HTTP lab controls, authenticated product operations, SSRF rejection, readiness and nonroot identity. Docker is unavailable in the implementation sandbox. This sandbox also denies chown to UID1000 (`EINVAL`); the positive root-drop startup test explicitly skips only when this capability is unavailable, while failure-closed startup still runs. The positive startup/restart test runs when the test host is root and ownership mapping is available; Docker CI separately starts a root-owned tmpfs volume, initializes it, and verifies the HTTP process UID1000. No current product container/hosting success is inferred from older lab CI.

## Vercel

`vercel.json` builds `node scripts/build-frontend.mjs` into public static `dist`. Destinations are the deployed Railway origin `https://stopline-production-05c5.up.railway.app` in both fixed-origin Node adapters and legacy/health rewrites. No dynamic user-controlled backend URL is accepted. A backend-domain change requires updating all these literal targets together.

Authenticated workspace/history/create/export/delete routes go through native `api/product.mjs`, which validates the route/method/UUID, body limit and bearer shape, forwards the incoming cancellation signal, and returns safe errors. The more-specific product stream rewrite precedes metadata and generic routes. `api/stream.mjs` supports both legacy and product selectors, authenticates product streams, forwards only the workspace Authorization, passes `request.signal` to the fixed backend fetch and returns the live readable body without buffering. Both functions set `supportsCancellation:true,maxDuration:30`; the backend stream cap is 15 seconds. Standalone functions export `default {fetch:handler}`.

`PUBLIC_ORIGIN` permits exactly the configured canonical HTTPS origin alongside direct Host-derived same origin. Forwarded headers never expand it. No wildcard CORS headers or cookies are used. Bearer authentication is still required independently. Other Vercel preview domains are not implicitly permitted for mutations. All API responses use no-store/no-transform, and the UI has same-origin CSP, external scripts/styles and no inline code.

Validate the **actual new deployment** in a browser: generic GET completion, threshold/manual cancellation with both policies, an authorized OpenAI-compatible wire test, history/export/delete, volume restart durability and cross-workspace refusal. Check that actual client-cancel events reach Railway through Vercel and distinguish socket abort from provider work/billing. Prior lab hosted controls are historical evidence only. Root owns deployment and release approval; this source update alone does not change hosting.

## Product API

JSON responses/errors use no-store. `POST /api/workspaces` with `{}` returns 201 `{token,workspace:{createdAt}}`. All other product routes require `Authorization: Bearer <64 lowercase hex characters>`; only the hash is persisted. The token is returned once. The bearer grants all workspace actions; there is no password recovery or separate permission model.

`POST /api/profile-runs` requires exactly:

```json
{"mode":"get","endpoint":"https://your-public-host/stream?count=10","policy":"propagate","cancelAfterChunks":3,"cancelAfterMs":2000}
```

`policy` is `propagate` or `observe`. `cancelAfterChunks` is null or integer1..100; `cancelAfterMs` null or integer250..10000; at least one must be nonnull. These are saved browser instructions, not a fake server cancellation trigger. The first actual browser threshold aborts its streaming fetch.

OpenAI mode uses `mode:"openai"`, full HTTPS URL ending `/v1/chat/completions`, plus exactly `model` (1..120 printable chars), `prompt` (1..4000 chars), `maxTokens` (1..128), and `apiKey` (1..4096 nonwhitespace ASCII). The key is mandatory; no server-provided paid credentials exist. Request body is bounded to32768 bytes; both prompt/key are excluded from reports, which retain `promptLength`, model and maxTokens. Unknown fields are rejected.

Creation resolves/validates DNS then returns201 `{id,streamUrl,statusUrl}`. `GET streamUrl` is a single-use live text stream. The browser must send the bearer here too and actually abort the fetch to cancel. `GET statusUrl` returns the direct report; use a separate signal for polling after cancellation. `GET /api/profile-runs` returns `{runs,count}` newest-first, omitting event arrays. `GET /api/profile-runs/:id/export` returns the direct full report with download disposition. `DELETE /api/profile-runs/:id` stops/deletes that run; `DELETE /api/workspaces/current` stops all owned runs and deletes token/history. Both return204. Another workspace receives404 for a known foreign run ID.

Reports contain `id,status,terminal,createdAt,startedAt?,completedAt?,configuration,metrics,events,error,cleanup,stopReason?,observability`. Terminal statuses are completed,cancelled,timeout,error,interrupted; queued,running,settling are nonterminal. Metrics: `ttfbMs,headersMs,bytesReceived,chunksReceived,bytesAfterCancel,chunksAfterCancel,clientCancelledAtMs,upstreamAbortRequested,upstreamAborted,upstreamClosed,upstreamEnded,durationMs,upstreamStatus`. Unknown latencies/cancel time are null. Events have increasing `sequence`, relative monotonic `atMs`, fixed `kind`, optional numeric metadata, never response text. Chunk events are sampled to the first32 to bound history. `cleanup` reports owned activeRequest and activeTimers. Provider compute/billing are always `not observable`.

## Limits and outbound boundary

Two combined active product/lab slots; queued product expiry10s; active stream15s;1MiB response;4096 chunks. Instance run bucket12/min and workspace6/min; workspace creation10/min. These are shared single-process limits, not distributed abuse protection. Max1,000 workspaces,100runs/workspace,10,000runs total,30day expiry lazily enforced by mutations. Headers32768 bytes and64 count; body32768bytes with2s deadline. Header/request ingress timeout5s. Errors are safe constant text:400input/SSRF,401auth,403origin,404isolation,405method,409streamreuse,408slowbody,413size,415type,429budget,503storage/shutdown,507capacity.

Only HTTPS443; all DNS A/AAAA answers are validated, with conservative IPv4 special-use and IPv6 global-unicast exclusions and mapped-IPv4 checks. DNS has a2s cap; one validated IP is pinned into the actual request lookup. Original hostname controls SNI/certificate validation; certificate verification remains enabled. Agent reuse is disabled. Ordinary URL query parameters are sent and saved faithfully in private reports, subject to URL2048/query1024/pairs16/key64/value256 bounds. Credential-like keys such as token,key,auth,password,secret,signature are refused; do not put secrets in URL paths/ordinary values. No redirects, userinfo, fragments, arbitrary protocols/ports, custom headers or private-network bypass exists. Redirects become terminal errors with upstream status, without following Location or storing response bodies. Compressed upstream responses are refused; endpoints must honor identity encoding.

## Secondary lab

Legacy `/api/runs` still accepts its original exact5fields and keeps its original ephemeral fixture semantics: body8192bytes,20retained records,60s TTL,queued5s,12s total deadline. It is separate from authenticated durable product results. `node cli.mjs compare` retains local generator evidence; neither path contacts an external provider. The default UI profiles user endpoints.

Primary references: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html ; https://nodejs.org/api/https.html ; https://nodejs.org/api/dns.html ; https://www.sqlite.org/pragma.html ; https://www.sqlite.org/wal.html ; https://docs.railway.com/guides/volumes ; https://docs.railway.com/config-as-code/reference ; https://vercel.com/docs/functions/functions-api-reference ; https://vercel.com/docs/project-configuration/vercel-json .
