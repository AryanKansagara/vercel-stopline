import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { GET } from '../api/stream.mjs';
import { createApp } from '../server.mjs';
const BACKEND = 'https://stopline-production-05c5.up.railway.app';
const ID = '11111111-1111-4111-8111-111111111111';
const pause = ms => new Promise(ok => setTimeout(ok, ms));

test('standalone Vercel default fetch export uses the tested Web handler', () => { assert.equal(handler.fetch, GET); });

test('stream function rejects methods, invalid/duplicate IDs and extra URL inputs before fetch', async () => {
  const original = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  try {
    for (const query of ['', '?runId=nope', '?runId=../x', `?runId=${ID}&runId=${ID}`, `?runId=${ID}&url=https://evil.example`, `?runId=${ID}&backend=https://evil.example`]) assert.equal((await GET(new Request('https://frontend.example/api/stream' + query))).status, 400);
    assert.equal((await GET(new Request(`https://frontend.example/api/stream?runId=${ID}`, { method: 'POST' }))).status, 405);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('function forwards only fixed destination and identical request signal without consuming the body', async () => {
  const original = globalThis.fetch; let forwarded; const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('1:x\n')); c.close(); } });
  globalThis.fetch = async (url, options) => { forwarded = { url, options }; return new Response(source, { headers: { 'content-type': 'text/plain; charset=utf-8' } }); };
  try {
    const request = new Request(`https://frontend.example/api/stream?runId=${ID}`); const response = await GET(request);
    assert.equal(forwarded.url, `${BACKEND}/api/runs/${ID}/stream`); assert.equal(forwarded.options.signal, request.signal); assert.equal(forwarded.options.redirect, 'error');
    assert.equal(response.body, source); assert.equal(response.bodyUsed, false); assert.equal(response.headers.get('cache-control'), 'no-store, no-transform'); assert.equal(await response.text(), '1:x\n');
  } finally { globalThis.fetch = original; }
});
test('pre-aborted requests do not start upstream; network failures return safe errors', async () => {
  const original = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('private upstream detail'); };
  try {
    const control = new AbortController(); control.abort(); const aborted = await GET(new Request(`https://frontend.example/api/stream?runId=${ID}`, { signal: control.signal })); assert.equal(aborted.status, 499); assert.equal(calls, 0);
    const failed = await GET(new Request(`https://frontend.example/api/stream?runId=${ID}`)); assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes('private upstream detail')); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
async function transportCase(t, { policy, providerBehavior, cancel, beforeFirst = false }) {
  const original = globalThis.fetch, app = await createApp(); t.after(() => app.close());
  const config = { policy, providerBehavior, totalUnits: 12, intervalMs: 30, initialDelayMs: beforeFirst ? 300 : 30 };
  const created = await original(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) }); assert.equal(created.status, 201); const run = await created.json();
  // Test-only transport substitution: the handler still chooses its fixed HTTPS URL.
  // The actual upstream HTTP goes to the local application/lab, never a public host.
  globalThis.fetch = async (url, init) => { assert.equal(url, `${BACKEND}${run.streamUrl}`); return original(app.url + new URL(url).pathname, init); };
  try {
    const control = new AbortController(); const request = new Request(`https://frontend.example/api/stream?runId=${run.id}`, { signal: control.signal }); const response = await GET(request); assert.equal(response.status, 200);
    if (cancel) { const reader = response.body.getReader(); if (!beforeFirst) assert.ok((await reader.read()).value.length); control.abort(); await reader.cancel().catch(() => {}); }
    else assert.equal((await response.text()).trim().split('\n').length, 12);
    let result;
    for (let i = 0; i < 200; i++) { result = await (await original(app.url + run.statusUrl)).json(); if (result.terminal) break; await pause(10); }
    assert.ok(result.terminal); assert.equal(result.status, cancel ? 'cancelled' : 'completed'); assert.equal(result.cleanupForced, false);
    for (const field of ['activeTimers', 'activeProviderJobs', 'activeProxyRequests', 'openSockets', 'listeningServers']) assert.equal(result.cleanup[field], 0);
    return result;
  } finally { globalThis.fetch = original; }
}
test('function signal closes real upstream HTTP midstream and cooperative work actually stops', async t => {
  const r = await transportCase(t, { policy: 'propagate', providerBehavior: 'cooperative', cancel: true }); assert.ok(r.metrics.providerUnits < 12); assert.equal(r.metrics.providerCancellationObserved, true); assert.equal(r.metrics.propagatedAborts, 1);
});
test('function abort before first unit reaches actual provider timer', async t => {
  const r = await transportCase(t, { policy: 'propagate', providerBehavior: 'cooperative', cancel: true, beforeFirst: true }); assert.equal(r.metrics.providerUnits, 0); assert.equal(r.metrics.providerCancellationObserved, true);
});
test('function naive and noncooperative negative controls retain actual post-disconnect work', async t => {
  for (const [policy, providerBehavior] of [['naive', 'cooperative'], ['propagate', 'noncooperative']]) {
    const r = await transportCase(t, { policy, providerBehavior, cancel: true }); assert.equal(r.metrics.providerUnits, 12); assert.ok(r.metrics.providerUnitsAfterCancel > 0); assert.equal(r.metrics.providerCancellationObserved, false);
  }
});
test('function normal completion preserves every streamed unit', async t => {
  const r = await transportCase(t, { policy: 'propagate', providerBehavior: 'cooperative', cancel: false }); assert.equal(r.metrics.providerUnits, 12); assert.equal(r.metrics.clientCancelAtMs, null);
});
