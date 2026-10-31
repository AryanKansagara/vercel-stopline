# StopLine

**An executable laboratory for cancellation through streamed HTTP workloads.** A local client disconnects, a proxy decides whether to propagate the abort, and a controlled provider records whether its work actually stops.

This independent project is relevant to Vercel streaming applications, but it is not affiliated with Vercel. **The current prototype has no Vercel deployment, Vercel runtime adapter, AI model, or provider API integration.** It performs real loopback HTTP streaming and cancellation around an authored generator workload.

## Run

Requirements: Node.js 22+; verified locally with Node.js 24.22.1 on Linux. There are no runtime or development dependencies. No installation, API keys, accounts, Docker, or browser is needed.

```sh
node --test
node cli.mjs compare --repeats 3 --output run.json
```

`npm test` and `npm run demo` are aliases. `node cli.mjs --help` shows the CLI. The report output's parent directory must exist. All servers bind to ephemeral ports on `127.0.0.1`, and every run uses a fresh lab.

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

Eleven meaningful tests cover:

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

Cleanup tests inspect actual socket close events as well as application counters. Tests avoid requiring a fixed cancellation latency or exact in-flight unit count. GitHub Actions configuration runs tests and a one-repetition CLI comparison; it has not been executed remotely as part of this local implementation.

## Why TypeScript/JavaScript semantics matter more than C++ here

This project tests Node HTTP, stream backpressure, and abort propagation. It does not implement an inference engine, kernel, model loader, or compute scheduler. Native C++ would not resolve an incorrectly wired `AbortSignal` in a Node function. The stdlib ESM implementation keeps the actual protocol behavior observable without framework dependencies. Native inference projects should still choose C++ for the appropriate execution path.

## Next milestones

1. Introduce a Vercel Node function adapter configured for documented request cancellation and compare its event timeline with the local reference contract.
2. Add a provider adapter that records confirmed cancellation acknowledgements and returned usage without assuming a closed client request ends vendor work.
3. Test disconnects through a real browser and deployed ingress, including buffered responses, timeout, scale-down, and cleanup behavior.
4. Add a timeline viewer and repeated paired workloads with resource and latency distributions.

None of those milestones is completed by the local fixture. See [RESEARCH.md](RESEARCH.md) for primary sources and product overlap.

## Files

- `src/lab.mjs`: provider, proxy, client, lifecycle cleanup, and observed experiment runner.
- `cli.mjs`: paired-policy experiment and JSON report export.
- `test/lab.test.mjs`: correctness, error, cancellation, and backpressure tests.
- `benchmarks/local-http.json`: measured local fixture evidence.
- `.github/workflows/test.yml`: prepared CI workflow.
