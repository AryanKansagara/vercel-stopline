# StopLine

**An executable laboratory for cancellation through streamed HTTP workloads.** A local client disconnects, a proxy decides whether to propagate the abort, and a controlled provider records whether its work actually stops.

This independent project is relevant to Vercel streaming applications, but it is not affiliated with Vercel. **The deployed application includes a cancellation-aware Vercel Node stream adapter and a Railway backend. Three real browser cancellation controls passed on 2026-10-31. There is no AI model, provider API integration or vendor billing measurement.** It performs real loopback HTTP streaming and cancellation around an authored generator workload.

**Live demo:** [StopLine](https://vercel-stopline.vercel.app/).

## Run

Requirements: Node.js 22+; verified locally with Node.js 24.22.1 on Linux. There are no runtime or development dependencies. No installation, API keys, accounts, Docker, or browser is needed for CLI tests. The same-origin web application also runs directly with Node.

```sh
node --test
node cli.mjs compare --repeats 3 --output run.json
npm start
# Open http://localhost:3000
```

`npm test` and `npm run demo` are aliases. `node cli.mjs --help` shows the CLI. The report output's parent directory must exist. Every experiment uses fresh internal servers bound to ephemeral loopback ports. The web application listens on `0.0.0.0`, default port 3000, configurable with `PORT`. `npm run dev` runs the same server. See [deployment.md](deployment.md) for API, bounds, operational requirements, and container instructions.

## Actual architecture

There are **three components and two HTTP network hops**:

1. A client consumes newline-delimited stream units and optionally destroys its request after a specified number of units.
2. A proxy forwards the provider's actual HTTP stream, pauses upstream reads when downstream writes apply backpressure, and resumes on drain.
3. A controlled provider produces numbered units after configurable waits, with real timers and real socket writes. It can fail at an injected unit or ignore peer disconnection while continuing its fictional computation.

The `propagate` policy attaches an `AbortController` to the proxy's outgoing HTTP request. If its client response closes before finishing, the proxy aborts that request. The `naive` policy continues reading and discarding provider output. Both paths resume any paused upstream stream after downstream closure, avoiding a stranded backpressure wait.

A cooperative provider aborts its active timer when its response connection closes early. A noncooperative provider observes the closure but deliberately completes all scheduled units. This negative control makes the boundary visible: **closing a socket does not prove remote computation or billing stopped.**

Provider errors destroy the stream and reach the client as an error, rather than a false successful completion. Shutdown stops new connections, aborts controllers, clears tracked application timers, and waits for jobs, socket close events, and both listening servers. Concurrent `close()` callers receive the same shutdown promise, so each observes completed cleanup. Node's internal resources are not exhaustively instrumented; the report inventories the resources explicitly owned by this lab.

The default idle-settlement deadline derives from the configured initial delay and per-unit interval, with a minimum five-second budget and additional cleanup allowance. Accepted long-delay fixtures are not incorrectly cut off by a fixed five-second timeout. Callers can explicitly supply a shorter deadline to `waitForIdle()` when testing timeout behavior.

## Recorded experiment

[benchmarks/local-http.json](benchmarks/local-http.json) contains the full event ledger for 30 local runs: five scenarios, two policies, three repetitions. Policy order alternates between repetitions. The table below reports **observed authored work units after the client cancelled**, summed over three repetitions:

| Scenario | Naive drain | Propagate abort | Interpretation |
| --- | ---: | ---: | --- |
| Cancel before first generated unit | 36 | 0 | Cooperative provider stopped its initial timer |
| Cancel after three received units | 27 | 0 | Propagation prevented remaining fixture work |
| Provider ignores cancel | 27 | 27 | Abort reached the socket but did not stop computation |

Both policies delivered all 12 units on each normal-completion run. Both classified the injected provider failure as an error. All 30 runs ended with zero tracked provider jobs, proxy requests, application timers, sockets, and listening servers after shutdown.

These are small controlled observations, not a latency SLA, an AI performance result, or evidence about Vercel infrastructure. Network buffering and host load can allow additional in-flight units before cancellation is observed. No financial savings are claimed.

## Evidence format

Each report records:

- Fixture configuration separately from observed event records.
- Per-event monotonically ordered sequence numbers and same-process monotonic timestamps.
- Client completion, cancellation, or error status and received units/bytes.
- Provider generated units, writes, peer closures, cancellation acknowledgement, completion, and errors.
- Proxy abort propagation and backpressure counters.
- Work generated after the cancellation event, using event sequence rather than rounded timestamps to classify the boundary.
- Cancellation latency only when a provider cancellation event was actually observed; otherwise `null`.
- Resource counts before and after explicit server shutdown.

An absence of observed cancellation is not treated as zero cost. The fixture has no vendor billing; that field is marked unmeasured. A future live API adapter must retain unknown usage when cancellation prevents a final usage response.

## Verification

The eleven original lab tests are preserved. They cover:

- Normal stream completion over both HTTP connections.
- Midstream cancellation compared against the naive policy.
- Cancellation after provider acceptance but before the first generated unit.
- A provider that continues computing after disconnection.
- Provider failure and correct client error classification.
- Provider/proxy pause-and-drain backpressure with large chunks.
- Cancellation while backpressure is active.
- Idempotent shutdown while work is still pending.
- Concurrent shutdown calls waiting for the same completed cleanup.
- A valid six-second initial-delay fixture completing after early client cancellation.
- Invalid fixture configuration.

Cleanup tests inspect actual socket close events as well as application counters. Tests avoid requiring a fixed cancellation latency or exact in-flight unit count. Twenty-one additional HTTP-server tests exercise public relay fetch aborts, negative controls, strict schema/body/path boundaries, concurrent admission, queued expiry, deadlines, retention, and actual SIGTERM cleanup. The server exposes real events and post-close metrics, rather than a fake cancellation endpoint. GitHub Actions also configures a Docker build and owned-instance HTTP smoke. The GitHub Actions test/container jobs have passed, including the static frontend build. Docker remains unavailable locally; the hosted browser observations below are distinct evidence from the local tests.

## Why TypeScript/JavaScript semantics matter more than C++ here

This project tests Node HTTP, stream backpressure, and abort propagation. It does not implement an inference engine, kernel, model loader, or compute scheduler. Native C++ would not resolve an incorrectly wired `AbortSignal` in a Node function. The stdlib ESM implementation keeps the actual protocol behavior observable without framework dependencies. Native inference projects should still choose C++ for the appropriate execution path.

## Next milestones

1. Repeat the recorded hosted cancellation controls across deployment restarts and additional ingress conditions.
2. Add a provider adapter that records confirmed cancellation acknowledgements and returned usage without assuming a closed client request ends vendor work.
3. Expand hosted browser coverage for buffering, timeout, scale-down and cleanup behavior beyond the three recorded controls.
4. Validate the same-origin timeline interface with real browser ingress and broaden repeated paired workloads with resource and latency distributions.

The local fixture alone does not establish hosted behavior; the three recorded hosted controls below cover the linked deployment, while provider API and broader ingress validation remain future work. See [RESEARCH.md](RESEARCH.md) for primary sources and product overlap.

## Files

- `src/lab.mjs`: provider, proxy, client, lifecycle cleanup, and observed experiment runner.
- `cli.mjs`: paired-policy experiment and JSON report export.
- `test/lab.test.mjs`: correctness, error, cancellation, and backpressure tests.
- `benchmarks/local-http.json`: measured local fixture evidence.
- `.github/workflows/test.yml`: prepared CI workflow.

## Web application backend

`server.mjs` serves `web/` with a same-origin API. POST strict bounded fixture options to `/api/runs`, open its single-use `streamUrl`, abort the actual browser fetch to disconnect, and poll `statusUrl` until real resource cleanup completes. The path adds one public relay to the original three-component lab; the original lab still has three components and two network hops. Two active job slots, absolute deadlines, queued expiry, a creation-rate budget, result caps, and safe static-file boundaries bound each instance. A non-root Dockerfile and graceful shutdown support a future host; no live hosting or Vercel/provider integration is implied. The Vercel stream function passes the browser request signal to the fixed Railway backend; other API routes use external rewrites. Eight function tests exercise bounded routing, Web exports, real HTTP cancellation and both continuation controls through a test-only local transport substitution. They do not establish Vercel platform delivery of request cancellation. Full response schema, limitations and run commands are in [deployment.md](deployment.md).

[benchmarks/server-http.json](benchmarks/server-http.json) records a separate four-case public-relay smoke run against an ephemeral local server: normal completion generated 12 units; cooperative propagation cancelled after one generated unit with zero later units; naive and noncooperative controls each generated all 12 with 11 after cancellation. All four post-close inventories were zero. These authored observations are timing-dependent local fixture results, not provider savings or a hosted-ingress guarantee.


## Recorded hosted browser controls

On 2026-10-31, actual browser Start/Cancel actions and downloaded terminal JSON were checked on [the Vercel demo](https://vercel-stopline.vercel.app/), deployment `dpl_Bb2BSLNPRt5T2YxtCL9oXX8gg4Zf`, against the Railway backend. All three cases used 48 authored units, 120 ms spacing and a 250 ms initial delay. This is real hosted HTTP with a controlled generator, not inference or billing evidence.

| Policy / provider | Browser units received | Total origin units | Origin units after cancellation | Propagated aborts | Provider cancellation observed |
| --- | ---: | ---: | ---: | ---: | --- |
| Propagate / cooperative | 20 | 21 | 0 | 1 | yes |
| Naive / cooperative | 9 | 48 | 37 | 0 | no |
| Propagate / noncooperative | 4 | 48 | 42 | 1 | no |

Every case ended `cancelled` with `cleanupForced:false`, a real origin client-cancel event and zero tracked timers, provider jobs, proxy requests, sockets and lab listeners. Browser and origin counts differ because units can be in flight when cancellation occurs. These three manually triggered observations validate the cancellation boundary for that deployment; they are not a latency SLA or a guarantee about future deployments or external providers. The initial plain external rewrite failed to deliver disconnects, which motivated the dedicated cancellation-aware function.
