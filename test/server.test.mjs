import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp, validatePublicOrigin } from '../server.mjs';
const options = { policy: 'propagate', providerBehavior: 'cooperative', totalUnits: 12, intervalMs: 20, initialDelayMs: 20 };
const delay = ms => new Promise(ok => setTimeout(ok, ms));
async function fixture(t, extra = {}) {
  const webRoot = await mkdtemp(join(tmpdir(), 'stopline-web-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><h1>StopLine fixture</h1>');
  await writeFile(join(webRoot, 'app.js'), 'console.log("fixture");');
  const app = await createApp({ webRoot, dataDir: join(webRoot, "data"), ...extra });
  t.after(async () => { await app.close(); await rm(webRoot, { recursive: true, force: true }); });
  return { app, webRoot };
}
async function create(app, config = options) {
  const response = await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(response.status, 201, await response.clone().text()); return response.json();
}
async function terminal(app, run, timeout = 2500) {
  const until = Date.now() + timeout; let result;
  do {
    const response = await fetch(app.url + run.statusUrl); assert.equal(response.status, 200); result = await response.json();
    if (result.terminal) return result;
    await delay(10);
  } while (Date.now() < until);
  assert.fail('job did not settle: ' + JSON.stringify(result));
}
const settled = result => {
  assert.ok(result.cleanup); for (const key of ['activeTimers', 'activeProviderJobs', 'activeProxyRequests', 'openSockets', 'listeningServers']) assert.equal(result.cleanup[key], 0, key);
};
async function cancelled(t, policy, providerBehavior, beforeFirst = false) {
  const { app } = await fixture(t); const run = await create(app, { ...options, policy, providerBehavior, initialDelayMs: beforeFirst ? 300 : 20 });
  const control = new AbortController(); const response = await fetch(app.url + run.streamUrl, { signal: control.signal });
  const reader = response.body.getReader();
  if (!beforeFirst) { const first = await reader.read(); assert.ok(first.value.length > 0); }
  control.abort(); await reader.cancel().catch(() => {});
  const result = await terminal(app, run); settled(result);
  assert.equal(result.status, 'cancelled'); assert.equal(result.cleanupForced, false);
  assert.ok(result.events.some(e => e.kind === 'client-cancel')); assert.ok(result.events.some(e => e.kind === 'proxy-client-close'));
  return result;
}
test('same-origin health, readiness, static assets and HEAD are real HTTP', async t => {
  const { app } = await fixture(t);
  assert.equal((await fetch(app.url + '/healthz')).status, 200);
  assert.equal((await (await fetch(app.url + '/readyz')).json()).ready, true);
  const page = await fetch(app.url); assert.match(await page.text(), /StopLine fixture/); assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
  const head = await fetch(app.url + '/app.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
test('normal stream completes through public relay and lab with observed evidence', async t => {
  const { app } = await fixture(t); const run = await create(app, { ...options, totalUnits: 3 });
  const response = await fetch(app.url + run.streamUrl); assert.equal(response.status, 200); assert.equal((await response.text()).trim().split('\n').length, 3);
  const result = await terminal(app, run); assert.equal(result.status, 'completed'); assert.equal(result.metrics.providerUnits, 3); assert.equal(result.metrics.clientCancelAtMs, null); settled(result);
  assert.equal((await fetch(app.url + run.streamUrl)).status, 409);
});
test('real fetch AbortController disconnect stops cooperative provider midstream', async t => {
  const result = await cancelled(t, 'propagate', 'cooperative'); assert.ok(result.metrics.providerUnits < options.totalUnits); assert.equal(result.metrics.providerCancellationObserved, true); assert.equal(result.metrics.propagatedAborts, 1);
});
test('real fetch abort before first unit propagates with zero useful generator work', async t => {
  const result = await cancelled(t, 'propagate', 'cooperative', true); assert.equal(result.metrics.providerUnits, 0); assert.equal(result.metrics.providerCancellationObserved, true);
});
test('naive negative control continues real generator work after public disconnect', async t => {
  const result = await cancelled(t, 'naive', 'cooperative'); assert.equal(result.metrics.providerUnits, options.totalUnits); assert.ok(result.metrics.providerUnitsAfterCancel > 0); assert.equal(result.metrics.providerCancellationObserved, false); assert.equal(result.metrics.propagatedAborts, 0);
});
test('noncooperative negative control continues despite propagated socket abort', async t => {
  const result = await cancelled(t, 'propagate', 'noncooperative'); assert.equal(result.metrics.providerUnits, options.totalUnits); assert.ok(result.metrics.providerUnitsAfterCancel > 0); assert.equal(result.metrics.providerCancellationObserved, false); assert.equal(result.metrics.propagatedAborts, 1);
});
test('two slots include queued jobs; unopened jobs expire without lab resources', async t => {
  const { app } = await fixture(t, { limits: { queuedMs: 100 } }); const first = await create(app); const second = await create(app);
  const rejected = await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) }); assert.equal(rejected.status, 429);
  const result = await terminal(app, first); await terminal(app, second); assert.equal(result.status, 'expired'); assert.equal(result.metrics, null); assert.deepEqual(result.events, []); assert.equal(app.diagnostics().activeJobs, 0);
  const next = await create(app); assert.ok(next.id);
});
test('parallel creation cannot race past capacity and shutdown settles queued slots', async t => {
  const { app } = await fixture(t);
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) })));
  assert.equal(outcomes.filter(r => r.status === 201).length, 2); assert.equal(app.diagnostics().activeJobs, 2);
  const a = app.close(), b = app.close(); assert.equal(a, b); await a; assert.equal(app.diagnostics().activeJobs, 0); assert.equal(app.diagnostics().openSockets, 0);
});
test('deadline interrupts a live stream, marks forced cleanup and frees slot', async t => {
  const { app } = await fixture(t, { limits: { deadlineMs: 120 } }); const run = await create(app, { ...options, totalUnits: 60, initialDelayMs: 0, intervalMs: 150 });
  const response = await fetch(app.url + run.streamUrl); await response.text().catch(() => {});
  const result = await terminal(app, run); assert.equal(result.status, 'timeout'); assert.equal(result.cleanupForced, true); assert.ok(result.metrics.providerUnits < 60); settled(result);
});
test('shutting down live cooperative and noncooperative streams closes all resources', async t => {
  const { app } = await fixture(t); const runs = await Promise.all(['cooperative', 'noncooperative'].map(providerBehavior => create(app, { ...options, providerBehavior, totalUnits: 60, intervalMs: 150 })));
  const responses = await Promise.all(runs.map(run => fetch(app.url + run.streamUrl)));
  const drains = responses.map(r => r.text().catch(() => {})); await app.close(); await Promise.all(drains);
  assert.equal(app.diagnostics().activeJobs, 0); assert.equal(app.diagnostics().openSockets, 0);
});
test('strict schema, body size, content type and cross-origin creation fail safely', async t => {
  for (const value of [{ ...options, intervalMs: 0 }, { ...options, totalUnits: 61 }, { ...options, initialDelayMs: 501 }, { ...options, totalUnits: '4' }, { ...options, providerBehavior: 'vendor' }, { ...options, url: 'http://example.com' }, [], null]) {
    const { app } = await fixture(t); const response = await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); assert.equal(response.status, 400); assert.ok((await response.json()).error);
  }
  const { app } = await fixture(t);
  assert.equal((await fetch(app.url + '/api/runs', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(8193) })).status, 413);
  assert.equal((await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://elsewhere.example' }, body: JSON.stringify(options) })).status, 403);
});
test('path traversal, symlink escapes, non-assets and unsupported methods never expose source', async t => {
  const { app, webRoot } = await fixture(t); await symlink(join(webRoot, '..'), join(webRoot, 'escape'));
  for (const path of ['/%2e%2e%2fserver.mjs', '/escape/anything.js', '/server.mjs', '/.git/config', '/bad%00.js', '/%ZZ']) {
    const response = await fetch(app.url + path); assert.ok([400, 404].includes(response.status), path); assert.ok(!(await response.text()).includes('createLab'));
  }
  assert.equal((await fetch(app.url + '/healthz', { method: 'POST' })).status, 405);
  assert.equal((await fetch(app.url + '/api/runs/nope')).status, 404);
});
test('global creation token budget bounds repeated malformed requests', async t => {
  const { app } = await fixture(t, { limits: { createsPerMinute: 2 } });
  for (const status of [400, 400, 429]) assert.equal((await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, status);
});
test('retention is bounded and expired terminal IDs are removed lazily', async t => {
  const { app } = await fixture(t, { limits: { queuedMs: 15, retentionMs: 30, retained: 3 } });
  const run = await create(app); await delay(70); assert.equal((await fetch(app.url + run.statusUrl)).status, 404); assert.ok(app.diagnostics().retainedJobs <= 3);
});
test('PORT=0 entrypoint handles actual SIGTERM and exits cleanly', async () => {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; const started = new Promise((ok, fail) => { child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) ok(); }); child.once('error', fail); child.once('exit', code => fail(new Error('early exit ' + code))); });
  try { await started; const { url } = JSON.parse(stdout.trim().split('\n')[0]); assert.equal((await fetch(url + '/healthz')).status, 200); const exit = once(child, 'exit'); child.kill('SIGTERM'); const [code, signal] = await exit; assert.equal(code, 0); assert.equal(signal, null); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('chunked oversized body returns bounded safe JSON instead of resetting the socket', async t => {
  const { app } = await fixture(t);
  const observed = await new Promise((ok, fail) => {
    const request = http.request(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', data => text += data); response.on('end', () => ok({ status: response.statusCode, body: JSON.parse(text) })); response.on('error', fail);
    });
    request.on('error', fail); request.write(' '.repeat(4096)); request.end(' '.repeat(4097));
  });
  assert.equal(observed.status, 413); assert.match(observed.body.error, /8192/); assert.equal((await fetch(app.url + '/healthz')).status, 200);
});
test('retained results never exceed their configured cap across repeated queued runs', async t => {
  const { app } = await fixture(t, { limits: { queuedMs: 15, retained: 3 } }); let first;
  for (let i = 0; i < 6; i++) { const run = await create(app); first ??= run; await terminal(app, run); assert.ok(app.diagnostics().retainedJobs <= 3); }
  assert.equal((await fetch(app.url + first.statusUrl)).status, 404); assert.equal(app.diagnostics().activeJobs, 0);
});

test('preview dev entrypoint honors host/port/strictPort CLI arguments', async () => {
  const child = spawn(process.execPath, ['dev.mjs', '--host', '127.0.0.1', '--port', '0', '--strictPort'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; const started = new Promise((ok, fail) => { child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) ok(); }); child.once('error', fail); child.once('exit', code => fail(new Error('early preview exit ' + code))); });
  try { await started; const { url, preview } = JSON.parse(stdout.trim().split('\n')[0]); assert.equal(preview, true); assert.equal((await fetch(url + '/healthz')).status, 200); assert.notEqual(new URL(url).port, '1'); const exit = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exit)[0], 0); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('readiness rejects an index symlink outside the static asset boundary', async t => {
  const { app, webRoot } = await fixture(t); const outside = join(webRoot, '..', 'stopline-outside-' + Date.now() + '.html');
  t.after(() => rm(outside, { force: true })); await writeFile(outside, '<h1>outside</h1>'); await rm(join(webRoot, 'index.html')); await symlink(outside, join(webRoot, 'index.html'));
  assert.equal((await fetch(app.url + '/readyz')).status, 503); assert.equal((await fetch(app.url)).status, 404); assert.equal((await fetch(app.url + '/healthz')).status, 200);
});

test('PUBLIC_ORIGIN fails invalid startup configuration before binding resources', async () => {
  assert.equal(validatePublicOrigin(undefined), null);
  assert.equal(validatePublicOrigin('https://stopline.example'), 'https://stopline.example');
  for (const publicOrigin of ['', '*', 'https://*.example', 'http://stopline.example', 'https://stopline.example/', 'https://stopline.example/api', 'https://user:pass@stopline.example', 'https://stopline.example?x=1', 'https://stopline.example#fragment', 'https://stopline.example:443', ' https://stopline.example', 'https://stopline.example,https://other.example', null, 123]) {
    await assert.rejects(createApp({ publicOrigin }), /PUBLIC_ORIGIN/);
  }
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', PUBLIC_ORIGIN: '*' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', s => stdout += s); child.stderr.on('data', s => stderr += s);
  const [code] = await once(child, 'exit'); assert.notEqual(code, 0); assert.equal(stdout, ''); assert.match(stderr, /PUBLIC_ORIGIN/);
});
test('exact configured public Origin and direct same-origin work; spoofed forwarded origins do not', async t => {
  const { app } = await fixture(t, { publicOrigin: 'https://stopline.example', limits: { queuedMs: 20 } });
  const post = async (origin, extra = {}) => fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...extra }, body: JSON.stringify(options) });
  const allowed = await post('https://stopline.example'); assert.equal(allowed.status, 201); assert.equal(allowed.headers.get('access-control-allow-origin'), null);
  await terminal(app, await allowed.json());
  const direct = await post(app.url); assert.equal(direct.status, 201); await terminal(app, await direct.json());
  const forged = await post('https://forged.example', { 'x-forwarded-host': 'forged.example', 'x-forwarded-proto': 'https', forwarded: 'host=forged.example;proto=https' });
  assert.equal(forged.status, 403);
  for (const origin of ['https://stopline.example.evil.test', 'https://evil.stopline.example', 'http://stopline.example', 'https://stopline.example:444', 'null']) {
    const response = await post(origin, { 'x-forwarded-host': 'stopline.example', 'x-forwarded-proto': 'https', forwarded: 'host=stopline.example;proto=https' });
    assert.equal(response.status, 403, origin);
  }
});
