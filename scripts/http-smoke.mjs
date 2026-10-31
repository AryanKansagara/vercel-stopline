/** Run against a server you own; actual HTTP cancellation, no browser automation or fake cancel endpoint. */
import assert from 'node:assert/strict';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const delay = ms => new Promise(ok => setTimeout(ok, ms));
let ready = false;
for (let i = 0; i < 100; i++) {
  try { ready = (await fetch(base + '/readyz')).ok; } catch {}
  if (ready) break; await delay(100);
}
assert.ok(ready, 'server did not become ready');
const results = [];
for (const [policy, providerBehavior, abort] of [['propagate', 'cooperative', false], ['propagate', 'cooperative', true], ['naive', 'cooperative', true], ['propagate', 'noncooperative', true]]) {
  const configuration = { policy, providerBehavior, totalUnits: 12, intervalMs: 25, initialDelayMs: 50 };
  const created = await fetch(base + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(configuration) });
  assert.equal(created.status, 201); const run = await created.json();
  const control = new AbortController(); const response = await fetch(base + run.streamUrl, { signal: control.signal });
  if (abort) { const reader = response.body.getReader(); assert.ok((await reader.read()).value?.length); control.abort(); await reader.cancel().catch(() => {}); }
  else assert.equal((await response.text()).trim().split('\n').length, 12);
  let observed;
  for (let i = 0; i < 200; i++) {
    const status = await fetch(base + run.statusUrl); assert.equal(status.status, 200); observed = await status.json();
    if (observed.terminal) break; await delay(25);
  }
  assert.ok(observed.terminal); assert.equal(observed.status, abort ? 'cancelled' : 'completed'); assert.equal(observed.cleanupForced, false);
  for (const field of ['activeTimers', 'activeProviderJobs', 'activeProxyRequests', 'openSockets', 'listeningServers']) assert.equal(observed.cleanup[field], 0);
  if (abort && policy === 'propagate' && providerBehavior === 'cooperative') {
    assert.equal(observed.metrics.providerCancellationObserved, true); assert.ok(observed.metrics.providerUnits < 12);
  } else if (abort) { assert.equal(observed.metrics.providerUnits, 12); assert.ok(observed.metrics.providerUnitsAfterCancel > 0); }
  results.push({ configuration, status: observed.status, metrics: observed.metrics, cleanup: observed.cleanup });
}
console.log(JSON.stringify({ scope: 'Observed HTTP server smoke; controlled local generator, no vendor runtime or billing proof', results }, null, 2));
