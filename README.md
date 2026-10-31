# StopLine

StopLine profiles **your public HTTPS streaming endpoint** and saves private run reports. Measure time to first byte, received bytes and transport chunks, then see what the upstream connection does when your browser cancels. Use a generic GET stream or an OpenAI-compatible `/v1/chat/completions` endpoint with an ephemeral API key, model and prompt.

**Live site:** https://vercel-stopline.vercel.app/ . This product upgrade requires deployment and fresh hosted validation; earlier hosted observations below apply only to the original controlled laboratory.

## Use locally

Node.js **24+**, no npm dependencies:

```sh
npm test
DATA_DIR="$PWD/.data" npm run dev -- --host 127.0.0.1 --port 3000
# Open http://127.0.0.1:3000
```

Create a private workspace in the browser, enter the **full endpoint URL**, choose Propagate or Observe, and set a cancellation threshold in browser chunks, milliseconds, or both. The first threshold reached aborts the real browser stream fetch. Propagate then aborts StopLine's actual upstream request. Observe continues receiving upstream bytes after browser cancellation until the stream ends or the safety budget expires. These policies intentionally answer different questions; Observe can incur additional provider usage. OpenAI mode sends `stream:true` and at most 128 requested output tokens. Provider pricing, reasoning-token behavior and charges remain outside StopLine's control.

The browser workspace token grants access to its history; keep it private. It is a random 256-bit bearer token, stored in this browser, with only its SHA-256 hash stored server-side. Losing it loses access. It is not an email account or recoverable identity. Reports support history, comparison, JSON export, individual deletion and whole-workspace deletion.

## What the report proves

- Header latency and first-body-byte latency measured by StopLine's backend.
- Actual upstream bytes and Node transport chunks received, including bytes received **after the backend observed the browser connection close** in Observe mode.
- Actual request abort, request/response closure, normal end, terminal reason and owned request/timer cleanup.
- Neither provider compute termination nor billing savings. A closed HTTP socket cannot establish either.

Browser reader chunks, Node transport chunks and provider application tokens are different boundaries. Thresholds run in the browser and actual cancellation is recorded only when the public backend response closes early; no cancellation endpoint synthesizes that event. Buffering and in-flight data can move the boundary. Timeouts, byte caps, deletion and shutdown are recorded with their own stop reasons.

## Data and safety bounds

SQLite retains private configuration and metadata for up to 30 days, at most 100 runs per workspace, 1,000 workspaces and 10,000 total runs. The database has a 128 MiB page ceiling, short WAL checkpoints and an 8 MiB post-checkpoint journal target; capacity failures refuse further writes rather than falling back to volatile storage. Query strings with ordinary parameters are preserved for request fidelity in **private** reports. Credential-like query keys are rejected. Avoid sensitive values in URL paths or ordinary parameters: StopLine cannot recognize arbitrary secrets.

API keys, prompts and response bodies are not stored, exported or logged. Keys and prompts exist transiently while a run is queued and while constructing its actual request, and queued runs expire after ten seconds. Node/V8 does not promise cryptographic memory erasure. OpenAI-compatible credentials travel only in the outbound Authorization header; known credential echoes in the endpoint are rejected. Saved model fields redact an exact known API-key echo.

Only HTTPS port 443 is supported. Every DNS A/AAAA answer must be public, including IPv4-mapped IPv6 validation. One approved IP is pinned into the actual TLS socket lookup while keeping the original server name and certificate verification. Redirects are never followed. Private/link-local/loopback/reserved networks, URL credentials, fragments and credential-like query keys are rejected. There are two shared active slots, per-instance and per-workspace creation budgets, a 15-second stream deadline, a 1 MiB response budget and 4,096 transport-chunk ceiling. No arbitrary outbound headers or proxy destinations are accepted.

## Architecture and validation

`web/` is a static same-origin application. `api/product.mjs` relays only enumerated authenticated JSON routes to the fixed Railway origin. The cancellation-enabled Vercel Node `api/stream.mjs` forwards the incoming abort signal into its streaming fetch. `server.mjs` serves the UI and APIs; `src/profiler.mjs` measures actual HTTP lifecycle events; `src/outbound.mjs` validates and pins destinations; `src/store.mjs` owns SQLite.

`npm test` includes real controlled HTTP servers for propagate and observe negative controls, normal completion, OpenAI request-body/header verification, redirects/errors/caps/deadlines, private owner isolation, deletion, persistence/restart, DNS/IP adversarial cases, fixed-destination relay checks, secret scans, header limits and startup boundaries. The original lab's 11 engine tests and existing application/function tests remain. Controlled tests substitute **only** the outbound transport/DNS at an explicit constructor dependency seam so loopback test servers can be used; the public API exposes no bypass. They do not establish successful contact with an external provider or hosted product behavior.

See [deployment.md](deployment.md) for the exact API, durable volume, privilege drop, hosting and release checks. `npm run smoke` checks the original lab; `node scripts/product-smoke.mjs` checks authentication/deletion/SSRF refusal without external API calls. Docker CI builds and runs both.

## Secondary controlled laboratory

`node cli.mjs compare --repeats 3 --output run.json` retains the original three-component, two-network-hop local HTTP cancellation experiment. Its controlled generator can cooperate or deliberately continue work after disconnect. [benchmarks/local-http.json](benchmarks/local-http.json) records 30 actual local runs, including normal completion, injected failure and noncooperative negative controls. These authored work units are not production inference or billing measurements.

The **previous lab release**, deployed on 2026-10-31, passed three hosted browser controls: cooperative propagation produced zero post-cancel generator units; naive and noncooperative controls produced 37 and 42 respectively. All three settled without forced cleanup. A plain Vercel external rewrite initially swallowed browser disconnection; the dedicated cancellation-aware Node function corrected that boundary. Those observations do not validate this new product release or another provider's compute behavior.

## Primary references

- https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- https://nodejs.org/api/https.html
- https://nodejs.org/api/dns.html
- https://www.sqlite.org/pragma.html
- https://www.sqlite.org/wal.html
- https://vercel.com/docs/functions/functions-api-reference
- https://vercel.com/docs/functions/runtimes/node-js
- https://docs.railway.com/guides/volumes
- https://github.com/vercel/ai/discussions/5132

Independent project, not affiliated with Vercel, Railway or an inference provider.
