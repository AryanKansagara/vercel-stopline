/** Vercel Node Web handler. Its request.signal requires supportsCancellation in vercel.json. */
const BACKEND_ORIGIN = 'https://stopline-production-05c5.up.railway.app';
const backend = new URL(BACKEND_ORIGIN);
if (backend.protocol !== 'https:' || backend.origin !== BACKEND_ORIGIN || backend.username || backend.password || backend.hostname.includes('*')) {
  throw new Error('Stream backend must be the fixed canonical HTTPS origin');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headers = {
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
};
const error = (status, message) => Response.json({ error: message }, { status, headers });
export async function GET(request) {
  if (request.method !== 'GET') return error(405, 'GET required');
  let url;
  try { url = new URL(request.url); } catch { return error(400, 'Invalid stream request'); }
  const ids = url.searchParams.getAll('runId');
  if (ids.length !== 1 || !UUID.test(ids[0]) || [...url.searchParams.keys()].some(key => key !== 'runId')) return error(400, 'One valid runId is required');
  if (request.signal.aborted) return error(499, 'Client disconnected');
  try {
    const upstream = await fetch(`${BACKEND_ORIGIN}/api/runs/${ids[0]}/stream`, {
      method: 'GET', signal: request.signal, redirect: 'error', cache: 'no-store', headers: { accept: 'text/plain' },
    });
    // Pass the live ReadableStream through. Never text(), json(), buffer, or drain on disconnect.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...headers, 'content-type': upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8' },
    });
  } catch {
    if (request.signal.aborted) return error(499, 'Client disconnected');
    console.error(JSON.stringify({ event: 'stream-upstream-failed' }));
    return error(502, 'Upstream stream unavailable');
  }
}
// Standalone (non-Next.js) Vercel Node function entrypoint.
export default { fetch: GET };
