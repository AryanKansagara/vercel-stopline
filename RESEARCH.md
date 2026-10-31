# Research and integration boundary

Consulted on 2026-10-31.

Vercel already supports streaming responses and recommends its AI SDK for provider integrations. Its Functions API documents cancellation in the Node.js runtime, configured through `supportsCancellation`, and explains that work which must finish after cancellation belongs in `waitUntil` or `after` promises. Vercel also documents termination cleanup constraints.

Primary sources:

- [Vercel Functions API reference](https://vercel.com/docs/functions/functions-api-reference)
- [Vercel streaming functions](https://vercel.com/docs/functions/streaming-functions)

Those are existing platform features. StopLine does not claim that Vercel lacks cancellation or that it invented streaming aborts. The proposed opportunity is an application-level, evidence-producing test of whether abort intent crosses every relevant boundary and whether downstream work actually acknowledges termination.

The architecture and opportunity are an inference from the documented lifecycle constraints, not a statement of Vercel's roadmap. No claim of unique prior art is made.

## Local proof versus required hosted proof

| Verified by this prototype | Not verified |
| --- | --- |
| Real local HTTP stream consumption and disconnect | Vercel ingress/client disconnect semantics |
| Node AbortController propagation to an upstream request | Vercel function runtime cancellation configuration |
| Cooperative fixture timer cancellation | Vendor AI generation cancellation |
| Noncooperative fixture continuing after socket closure | Real provider billing or credit refunds |
| Explicit cleanup after completion, failure, and cancellation | Cleanup surviving function termination or instance scale-down |
| Large-chunk backpressure pause/drain behavior | Browser/proxy buffering in deployed regions |

The distinction is intentional. A real provider can finish work before receiving an abort, ignore an abort, or stop returning usage while the final bill remains unknown. The future integration must record these outcomes separately. It must not replace missing usage with zero.

No cloud account, secret, private telemetry, payment method, or production endpoint was used. The authored fixture has no real economic or business side effects.
