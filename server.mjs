/** Public relay around the real loopback lab. No cloud/vendor API or simulated cancellation counts. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab } from './src/lab.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'failed', 'timeout', 'shutdown']);
const FIELDS = ['policy', 'providerBehavior', 'totalUnits', 'intervalMs', 'initialDelayMs'];
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function validatePublicOrigin(value) {
  if (value === undefined) return null;
  const message = 'PUBLIC_ORIGIN must be one canonical HTTPS origin without credentials, path, query, fragment or wildcard';
  if (typeof value !== 'string' || value.length > 512) throw new Error(message);
  let parsed; try { parsed = new URL(value); } catch { throw new Error(message); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value
      || parsed.hostname.includes('*') || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(message);
  return value;
}
export function validateRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== FIELDS.length
      || FIELDS.some(key => !Object.hasOwn(value, key))) throw new HttpError(400, 'Exactly five experiment fields are required');
  if (!['naive', 'propagate'].includes(value.policy) || !['cooperative', 'noncooperative'].includes(value.providerBehavior)) throw new HttpError(400, 'Invalid experiment policy or provider behavior');
  for (const [key, lo, hi] of [['totalUnits', 1, 60], ['intervalMs', 10, 150], ['initialDelayMs', 0, 500]]) {
    if (!Number.isInteger(value[key]) || value[key] < lo || value[key] > hi) throw new HttpError(400, `Invalid ${key}: expected integer ${lo}..${hi}`);
  }
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}
function json(response, status, data, extra = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  response.end(JSON.stringify(data));
}
async function body(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type application/json required');
  if (request.headers['content-length'] && Number(request.headers['content-length']) > 8192) throw new HttpError(413, 'Body exceeds 8192 bytes');
  return new Promise((resolveBody, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', failed); };
    const fail = error => { cleanup(); request.resume(); reject(error); };
    const failed = () => fail(new HttpError(400, 'Request body could not be read'));
    const aborted = () => fail(new HttpError(400, 'Request body was interrupted'));
    const data = chunk => { bytes += chunk.length; if (bytes > 8192) return fail(new HttpError(413, 'Body exceeds 8192 bytes')); chunks.push(chunk); };
    const end = () => { cleanup(); try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Malformed JSON')); } };
    const timer = setTimeout(() => fail(new HttpError(408, 'Request body deadline exceeded')), 2000);
    request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', failed);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function createApp({ host = '127.0.0.1', port = 0, webRoot = resolve(ROOT, 'web'),
  publicOrigin = process.env.PUBLIC_ORIGIN, limits = {} } = {}) {
  // Validate configuration before creating any listener or job resources.
  const allowedPublicOrigin = validatePublicOrigin(publicOrigin);
  // Overrides are for deterministic local tests only, and cannot relax production ceilings.
  const settings = { active: 2, retained: 20, queuedMs: 5000, deadlineMs: 12000, retentionMs: 60000, createsPerMinute: 12, ...limits };
  for (const [key, max] of Object.entries({ active: 2, retained: 20, queuedMs: 5000, deadlineMs: 12000, retentionMs: 60000, createsPerMinute: 12 })) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > max) throw new Error(`Invalid limit ${key}`);
  }
  if (Object.keys(settings).length !== 6) throw new Error('Unknown limit');
  const jobs = new Map(), sockets = new Set();
  let accepting = true, shutdownPromise, tokens = settings.createsPerMinute, refilledAt = Date.now();
  const active = () => [...jobs.values()].filter(job => !TERMINAL.has(job.status)).length;
  const report = job => ({ id: job.id, status: job.status, terminal: TERMINAL.has(job.status), configuration: job.configuration,
    metrics: job.lab?.snapshot() ?? null, events: job.lab ? [...job.lab.events] : [], cleanup: job.cleanup,
    error: job.error, createdAt: job.createdAt, cleanupForced: job.cleanupForced,
    notice: 'Actual local HTTP and controlled generator; no Vercel runtime, inference or provider billing validation.' });
  function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) if (TERMINAL.has(job.status) && now - job.finishedAt >= settings.retentionMs) jobs.delete(id);
    while (jobs.size >= settings.retained) {
      const removable = [...jobs].find(([, job]) => TERMINAL.has(job.status));
      if (!removable) break;
      jobs.delete(removable[0]);
    }
  }
  function finalize(job, status, forced = false) {
    if (job.finalizing) return job.finalizing;
    job.status = 'settling';
    job.finalizing = (async () => {
      clearTimeout(job.queuedTimer);
      // A deadline/shutdown can interrupt an existing natural settle operation.
      if (forced) { job.cleanupForced = true; job.relay?.destroy(); await job.lab?.close(); }
      else await job.lab?.waitForIdle(settings.deadlineMs + 500);
      await job.lab?.close();
    })().catch(async () => {
      status = 'failed'; job.error = 'Experiment resources failed to settle'; job.cleanupForced = true;
      job.relay?.destroy(); await job.lab?.close();
    }).then(() => {
      clearTimeout(job.deadlineTimer);
      job.cleanup = job.lab?.snapshot() ?? null;
      job.status = job.forcedStatus ?? status; job.finishedAt = Date.now();
    });
    return job.finalizing;
  }
  function force(job, status) {
    if (TERMINAL.has(job.status)) return Promise.resolve();
    job.forcedStatus = status; job.cleanupForced = true; job.status = 'settling';
    job.relay?.destroy();
    if (job.response && !job.response.destroyed) job.response.destroy();
    // Initialization may still be binding its two local servers. Finalize only after that promise.
    return Promise.resolve(job.initializing).then(async () => {
      await job.lab?.close();
      return finalize(job, status, true);
    });
  }
  async function stream(job, request, response) {
    if (job.status !== 'queued' || job.claimed) throw new HttpError(409, 'Stream is single-use and no longer queued');
    job.claimed = true; job.status = 'running'; job.response = response; clearTimeout(job.queuedTimer);
    let cancelled = false, incoming, drain;
    response.on('error', () => {});
    response.once('close', () => {
      if (response.writableFinished || job.forcedStatus) return;
      cancelled = true;
      job.lab?.recordClientCancel();
      if (drain) response.off('drain', drain);
      incoming?.resume();
      job.relay?.destroy(); // Real socket close reaches lab proxy; lab policy decides whether provider stops.
    });
    try {
      job.initializing = createLab({ ...job.configuration, payloadBytes: 32 });
      job.lab = await job.initializing;
      if (cancelled || response.destroyed || job.forcedStatus) {
        if (cancelled) job.lab.recordClientCancel();
        await finalize(job, job.forcedStatus ?? 'cancelled', Boolean(job.forcedStatus)); return;
      }
      await new Promise(resolveDone => {
        let done = false;
        const finish = (status, error = null) => {
          if (done) return; done = true;
          if (drain) response.off('drain', drain);
          if (error) job.error = error;
          if (status === 'failed' && !response.destroyed) response.destroy();
          void finalize(job, cancelled ? 'cancelled' : status).then(resolveDone);
        };
        const upstream = http.request(job.lab.proxyUrl + '/stream', { agent: false }, input => {
          incoming = input;
          if (response.destroyed) { input.destroy(); return; }
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
          response.flushHeaders();
          input.on('data', chunk => {
            if (response.destroyed) return;
            if (!response.write(chunk)) {
              input.pause(); drain = () => { drain = undefined; input.resume(); }; response.once('drain', drain);
            }
          });
          input.once('end', () => { if (!response.destroyed) response.end(); finish('completed'); });
          input.once('aborted', () => finish('failed', cancelled ? null : 'Upstream stream ended unexpectedly'));
          input.on('error', () => finish('failed', cancelled ? null : 'Upstream stream failed'));
        });
        job.relay = upstream;
        upstream.on('error', () => finish('failed', cancelled ? null : 'Upstream request failed'));
        upstream.end();
        // A close can race the upstream request setup in the same event loop turn.
        if (cancelled || response.destroyed) upstream.destroy();
      });
    } catch {
      job.error = 'Experiment could not start';
      if (!response.headersSent) json(response, 500, { error: job.error }); else response.destroy();
      await finalize(job, 'failed', true);
    }
  }
  async function staticFile(pathname, response, method) {
    let decoded; try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Invalid path encoding'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw new HttpError(404, 'Not found');
    const root = await realpath(webRoot).catch(() => null);
    if (!root) throw new HttpError(503, 'Interface assets are unavailable');
    const candidate = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
    const file = await realpath(candidate).catch(() => null);
    if (!file || relative(root, file).startsWith('..') || relative(root, file).startsWith('/')) throw new HttpError(404, 'Not found');
    const type = MIME[extname(file)]; const info = await stat(file);
    if (!type || !info.isFile() || info.size > 2 * 1024 * 1024) throw new HttpError(404, 'Not found');
    const content = method === 'HEAD' ? undefined : await readFile(file);
    response.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-cache' });
    response.end(content);
  }
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 2000 }, async (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const rawPath = (request.url ?? '/').split('?')[0];
      if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /\\|\0/.test(rawPath)) throw new HttpError(400, 'Invalid request path');
      if (rawPath === '/healthz' && request.method === 'GET') return json(response, 200, { ok: true });
      if (rawPath === '/readyz' && request.method === 'GET') {
        const root = await realpath(webRoot).catch(() => null);
        const index = await realpath(resolve(webRoot, 'index.html')).catch(() => null);
        const confined = root && index && !relative(root, index).startsWith('..') && !relative(root, index).startsWith('/');
        const assets = Boolean(confined && await stat(index).then(s => s.isFile() && s.size <= 2 * 1024 * 1024, () => false));
        return json(response, accepting && assets ? 200 : 503, { ready: accepting && assets, activeJobs: active(), retainedJobs: jobs.size });
      }
      prune();
      if (rawPath === '/api/runs') {
        if (request.method !== 'POST') throw new HttpError(405, 'POST required');
        if (!accepting) throw new HttpError(503, 'Server is shutting down');
        // Origin is compared exactly; forwarded host/proto headers never expand this allowlist.
        if (request.headers.origin && request.headers.origin !== allowedPublicOrigin
            && request.headers.origin !== `http://${request.headers.host}`
            && request.headers.origin !== `https://${request.headers.host}`) throw new HttpError(403, 'Same-origin or configured public origin required');
        const now = Date.now();
        tokens = Math.min(settings.createsPerMinute, tokens + (now - refilledAt) * settings.createsPerMinute / 60000); refilledAt = now;
        if (tokens < 1) throw new HttpError(429, 'Creation rate budget exhausted');
        // Charge attempted creations too, so malformed requests cannot bypass this global budget.
        tokens -= 1;
        if (active() >= settings.active) throw new HttpError(429, 'Two experiment slots are occupied');
        const configuration = validateRun(await body(request));
        // Body readers are asynchronous; check capacity again before synchronous reservation.
        if (!accepting) throw new HttpError(503, 'Server is shutting down');
        if (active() >= settings.active) throw new HttpError(429, 'Two experiment slots are occupied');
        prune();
        const id = randomUUID(), job = { id, configuration, status: 'queued', createdAt: new Date().toISOString(), lab: null, cleanup: null, error: null, cleanupForced: false };
        jobs.set(id, job);
        job.queuedTimer = setTimeout(() => { void force(job, 'expired'); }, settings.queuedMs); job.queuedTimer.unref();
        job.deadlineTimer = setTimeout(() => { void force(job, 'timeout'); }, settings.deadlineMs); job.deadlineTimer.unref();
        return json(response, 201, { id, streamUrl: `/api/runs/${id}/stream`, statusUrl: `/api/runs/${id}` });
      }
      const match = /^\/api\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/stream)?$/.exec(rawPath);
      if (match) {
        if (request.method !== 'GET') throw new HttpError(405, 'GET required');
        const job = jobs.get(match[1]); if (!job) throw new HttpError(404, 'Experiment not found or expired');
        if (match[2]) return await stream(job, request, response);
        return json(response, 200, report(job));
      }
      if (rawPath.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'GET or HEAD required');
      await staticFile(rawPath, response, request.method);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      json(response, status, { error: error instanceof HttpError ? error.message : 'Request could not be completed' }, [408, 413, 415].includes(status) ? { connection: 'close' } : {});
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => { server.off('error', fail); ok(); }); });
  const address = server.address();
  return { server, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    diagnostics: () => ({ accepting, activeJobs: active(), retainedJobs: jobs.size, openSockets: sockets.size }),
    close() {
      if (!shutdownPromise) shutdownPromise = (async () => {
        accepting = false;
        const stopped = new Promise(ok => server.close(ok));
        await Promise.allSettled([...jobs.values()].map(job => force(job, 'shutdown')));
        for (const job of jobs.values()) { clearTimeout(job.queuedTimer); clearTimeout(job.deadlineTimer); }
        const closed = [...sockets].map(socket => new Promise(ok => { if (socket.closed) { sockets.delete(socket); return ok(); } socket.once('close', ok); socket.destroy(); }));
        server.closeAllConnections(); await Promise.all(closed); await stopped;
      })();
      return shutdownPromise;
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be integer 0..65535');
  const app = await createApp({ host: '0.0.0.0', port });
  console.log(JSON.stringify({ event: 'listening', url: app.url, fixture: true }));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
