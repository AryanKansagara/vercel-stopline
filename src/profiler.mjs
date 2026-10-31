import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { RunStore } from './store.mjs';
import { validateEndpoint, resolvePublicTarget, openPinnedRequest } from './outbound.mjs';
const ACTIVE = new Set(['queued','running','settling']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 1048576;
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
function send(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-transform' });
  res.end(status === 204 ? undefined : JSON.stringify(data));
}
async function readJSON(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'Content-Type application/json required');
  if (Number(req.headers['content-length'] ?? 0) > 32768) throw new ApiError(413, 'Body exceeds 32768 bytes');
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    const clear = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', broken); req.off('aborted', broken); };
    const reject = error => { clear(); req.resume(); fail(error); };
    const broken = () => reject(new ApiError(400, 'Request body interrupted'));
    const data = chunk => { size += chunk.length; if (size > 32768) return reject(new ApiError(413, 'Body exceeds 32768 bytes')); chunks.push(chunk); };
    const end = () => { clear(); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new ApiError(400, 'Malformed JSON')); } };
    const timer = setTimeout(() => reject(new ApiError(408, 'Request body deadline exceeded')), 2000);
    req.on('data', data); req.once('end', end); req.once('error', broken); req.once('aborted', broken);
  });
}
export function validateProfileRequest(input) {
  const basic = ['mode','endpoint','policy','cancelAfterChunks','cancelAfterMs'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['get','openai'].includes(input.mode)) throw new ApiError(400, 'Select GET or OpenAI-compatible mode');
  const fields = input.mode === 'openai' ? [...basic,'model','prompt','maxTokens','apiKey'] : basic;
  if (Object.keys(input).length !== fields.length || fields.some(k => !Object.hasOwn(input, k))) throw new ApiError(400, 'Unexpected or missing profile fields');
  if (!['propagate','observe'].includes(input.policy)) throw new ApiError(400, 'Select propagate or observe policy');
  for (const [name,min,max] of [['cancelAfterChunks',1,100],['cancelAfterMs',250,10000]]) if (input[name] !== null && (!Number.isInteger(input[name]) || input[name] < min || input[name] > max)) throw new ApiError(400, `Invalid ${name}`);
  if (input.cancelAfterChunks === null && input.cancelAfterMs === null) throw new ApiError(400, 'Choose a cancellation threshold');
  let endpoint; try { endpoint = validateEndpoint(input.endpoint).href; } catch (e) { throw new ApiError(400, e.message); }
  if (input.mode === 'openai') {
    if (!new URL(endpoint).pathname.endsWith('/v1/chat/completions')) throw new ApiError(400, 'OpenAI endpoint must end in /v1/chat/completions');
    if (typeof input.model !== 'string' || input.model.length < 1 || input.model.length > 120 || /[\x00-\x1f]/.test(input.model)) throw new ApiError(400, 'Model must contain 1..120 printable characters');
    if (typeof input.prompt !== 'string' || input.prompt.length < 1 || input.prompt.length > 4000) throw new ApiError(400, 'Prompt must contain 1..4000 characters');
    if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 128) throw new ApiError(400, 'maxTokens must be 1..128');
    if (typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(input.apiKey)) throw new ApiError(400, 'API key must contain 1..4096 non-whitespace ASCII characters');
    let decodedEndpoint = endpoint; for (let i=0;i<3;i++) { try { decodedEndpoint = decodeURIComponent(decodedEndpoint); } catch { break; } if (decodedEndpoint.includes(input.apiKey)) throw new ApiError(400, 'Do not put API credentials in endpoint URLs'); }
    if (endpoint.includes(input.apiKey) || [...new URL(endpoint).searchParams.values()].some(v => v.includes(input.apiKey))) throw new ApiError(400, 'Do not put API credentials in endpoint URLs');
  }
  const saved = Object.fromEntries(basic.map(k => [k, k === 'endpoint' ? endpoint : input[k]]));
  if (input.mode === 'openai') { saved.model = input.model.split(input.apiKey).join('[redacted]'); saved.maxTokens = input.maxTokens; saved.promptLength = input.prompt.length; }
  return { saved, runtime: { ...input, endpoint } };
}
class Bucket {
  constructor(max) { this.max = max; this.tokens = max; this.at = Date.now(); }
  take() { const now = Date.now(); this.tokens = Math.min(this.max, this.tokens + (now - this.at) * this.max / 60000); this.at = now; if (this.tokens < 1) return false; this.tokens--; return true; }
}
export class Profiler {
  constructor({ dataDir, otherActive = () => 0, allowOrigin = () => true, dependencies = {} }) {
    this.store = new RunStore(dataDir); this.jobs = new Map(); this.admitting = 0; this.admissionTasks = new Set(); this.otherActive = otherActive; this.allowOrigin = allowOrigin;
    this.resolve = dependencies.resolvePublicTarget ?? resolvePublicTarget; this.open = dependencies.openPinnedRequest ?? openPinnedRequest;
    this.deadlineMs = Math.min(dependencies.deadlineMs ?? 15000,15000); this.queuedMs = Math.min(dependencies.queuedMs ?? 10000,10000);
    this.globalBudget = new Bucket(12); this.workspaceBudget = new Map(); this.workspaceCreation = new Bucket(10); this.closing = false;
  }
  activeCount() { return this.jobs.size + this.admitting; }
  auth(req) { const match = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? ''); const owner = match && this.store.authenticate(match[1]); if (!owner) throw new ApiError(401, 'A valid private workspace token is required'); return owner; }
  record(job, kind, fields = {}) { job.report.events.push({ sequence: job.sequence++, atMs: +(performance.now() - job.started).toFixed(3), kind, ...fields }); }
  persist(job) { try { this.store.save(job.owner, job.report); job.lastSaved = performance.now(); return true; } catch { job.storageError = true; if (!job.pending) queueMicrotask(() => { void this.stop(job,'error','storage_capacity','Private storage capacity exhausted'); }); return false; } }
  snapshot(job) { const result = structuredClone(job.report); if (job.startedAt) result.metrics.durationMs = +(performance.now() - job.started).toFixed(3); return result; }
  finish(job, status, reason, error = null) {
    if (job.pending) return;
    job.pending = { status, reason, error }; job.stopping = true; job.report.status = 'settling';
    for (const timer of job.timers) clearTimeout(timer); job.timers.clear();
    if (job.response && !job.response.destroyed && !job.response.writableEnded) job.response.end();
    if (!job.request || job.closed) this.finalize(job);
  }
  finalize(job) {
    if (job.finalized || !job.pending) return; job.finalized = true;
    job.runtime = null; job.target = null; job.request = null; job.incoming = null; job.response = null;
    job.report.status = job.pending.status; job.report.stopReason = job.pending.reason; job.report.error = job.pending.error; job.report.terminal = true;
    job.report.metrics.durationMs = +(performance.now() - job.started).toFixed(3); job.report.completedAt = new Date().toISOString();
    job.report.cleanup = { activeRequest: false, activeTimers: 0 }; this.record(job, 'run-settled'); this.persist(job); this.jobs.delete(job.report.id); job.doneResolve();
  }
  stop(job, status, reason, error = null) {
    if (job.finalized) return job.done;
    this.finish(job,status,reason,error); job.report.metrics.upstreamAbortRequested = Boolean(job.request); job.controller?.abort(); job.request?.destroy();
    return job.done;
  }
  async create(owner, input) {
    if (!this.globalBudget.take()) throw new ApiError(429, 'Instance run rate budget exhausted');
    let budget = this.workspaceBudget.get(owner); if (!budget) { if (this.workspaceBudget.size >= 1000) this.workspaceBudget.delete(this.workspaceBudget.keys().next().value); budget = new Bucket(6); this.workspaceBudget.set(owner,budget); }
    if (!budget.take()) throw new ApiError(429, 'Workspace run rate budget exhausted');
    if (this.activeCount() + this.otherActive() >= 2) throw new ApiError(429, 'Two run slots are occupied');
    const { saved, runtime } = validateProfileRequest(input); this.admitting++;
    let target;
    const lookup = Promise.resolve().then(() => this.resolve(runtime.endpoint)); this.admissionTasks.add(lookup);
    try { target = await lookup; } catch { throw new ApiError(400, 'Endpoint DNS must resolve only to public addresses'); } finally { this.admitting--; this.admissionTasks.delete(lookup); }
    if (this.closing) throw new ApiError(503, 'Server is shutting down');
    this.store.makeRoom(owner);
    const id = randomUUID(), report = { id, status: 'queued', terminal: false, createdAt: new Date().toISOString(), configuration: saved,
      metrics: { ttfbMs: null, headersMs: null, bytesReceived: 0, chunksReceived: 0, bytesAfterCancel: 0, chunksAfterCancel: 0, clientCancelledAtMs: null, upstreamAbortRequested: false, upstreamAborted: false, upstreamClosed: false, upstreamEnded: false, durationMs: 0, upstreamStatus: null },
      events: [], error: null, cleanup: { activeRequest: false, activeTimers: 1 }, observability: { providerCompute: 'not observable', providerBilling: 'not observable', responseBodiesPersisted: false } };
    let doneResolve; const done = new Promise(ok => doneResolve = ok);
    const job = { owner, target, runtime, report, timers: new Set(), started: performance.now(), sequence: 0, done, doneResolve, lastSaved: 0 };
    this.jobs.set(id,job); this.record(job,'run-created');
    const timer = setTimeout(() => { void this.stop(job,'error','unopened_expired','Unopened run expired; create a new run'); },this.queuedMs); timer.unref(); job.timers.add(timer); if (!this.persist(job)) { await this.stop(job,'error','storage_capacity'); throw new ApiError(507,'Private storage capacity exhausted'); }
    return { id, streamUrl: `/api/profile-runs/${id}/stream`, statusUrl: `/api/profile-runs/${id}` };
  }
  stream(job, req, res) {
    if (job.report.status !== 'queued') throw new ApiError(409,'Stream is single-use');
    for (const timer of job.timers) clearTimeout(timer); job.timers.clear();
    job.report.status = 'running'; job.started = performance.now(); job.startedAt = new Date().toISOString(); job.report.startedAt = job.startedAt; job.response = res; job.controller = new AbortController();
    const timer = setTimeout(() => { this.record(job,'deadline'); void this.stop(job,'timeout','deadline','Observation reached the 15-second safety deadline'); },this.deadlineMs); job.timers.add(timer); timer.unref();
    job.report.cleanup = { activeRequest: true, activeTimers: 1 }; this.record(job,'upstream-request'); this.persist(job);
    res.on('error',()=>{});
    res.once('close', () => {
      if (res.writableFinished || job.stopping || job.finalized) return;
      job.report.metrics.clientCancelledAtMs = +(performance.now() - job.started).toFixed(3); this.record(job,'client-cancel'); job.report.status = 'settling';
      job.incoming?.resume();
      if (job.report.configuration.policy === 'propagate') { this.record(job,'upstream-abort-requested'); void this.stop(job,'cancelled','client_abort'); }
      else this.persist(job);
    });
    const runtime = job.runtime; job.runtime = null;
    const headers = { accept: runtime.mode === 'openai' ? 'text/event-stream' : '*/*', 'accept-encoding': 'identity', 'user-agent': 'StopLine-Streaming-Profiler/1' };
    let body;
    if (runtime.mode === 'openai') {
      headers.authorization = `Bearer ${runtime.apiKey}`; headers['content-type'] = 'application/json';
      body = JSON.stringify({ model: runtime.model, messages: [{ role: 'user', content: runtime.prompt }], max_tokens: runtime.maxTokens, stream: true }); headers['content-length'] = Buffer.byteLength(body);
    }
    try {
      const outgoing = this.open(job.target,{ method: runtime.mode === 'openai' ? 'POST' : 'GET',headers,body,signal:job.controller.signal },incoming => {
        incoming.on('error',()=>{});
        job.incoming = incoming; job.report.metrics.headersMs = +(performance.now() - job.started).toFixed(3); job.report.metrics.upstreamStatus = incoming.statusCode; this.record(job,'upstream-headers',{ status: incoming.statusCode });
        const encoding = incoming.headers['content-encoding'];
        if (encoding && encoding !== 'identity') { void this.stop(job,'error','encoding','Encoded responses are unsupported; endpoint must honor identity encoding'); return; }
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) { void this.stop(job,'error','redirect','Redirect refused; use the final public endpoint directly'); return; }
        if (incoming.statusCode < 200 || incoming.statusCode >= 300) { void this.stop(job,'error','upstream_status',`Endpoint returned HTTP ${incoming.statusCode}`); return; }
        if (res.destroyed) { if (job.report.configuration.policy === 'propagate') { void this.stop(job,'cancelled','client_abort'); return; } }
        if (!res.destroyed) { res.writeHead(200, { 'content-type':'text/plain; charset=utf-8','cache-control':'no-store, no-transform','x-accel-buffering':'no','x-content-type-options':'nosniff' }); res.flushHeaders(); }
        incoming.on('data',chunk => {
          if (job.pending || job.finalized) return;
          const m = job.report.metrics; if (m.ttfbMs === null) { m.ttfbMs = +(performance.now() - job.started).toFixed(3); this.record(job,'first-byte'); }
          m.bytesReceived += chunk.length; m.chunksReceived++;
          if (m.clientCancelledAtMs !== null) { m.bytesAfterCancel += chunk.length; m.chunksAfterCancel++; }
          if (m.chunksReceived <= 32) this.record(job,'chunk',{ bytes:chunk.length });
          if (m.bytesReceived > MAX_BYTES || m.chunksReceived > 4096) { this.record(job,'response-limit'); void this.stop(job,'error','response_limit','Response exceeded the bounded observation budget'); return; }
          if (!res.destroyed && !res.writableEnded && !res.write(chunk)) { incoming.pause(); res.once('drain',()=>incoming.resume()); }
          if (performance.now() - job.lastSaved > 250) this.persist(job);
        });
        incoming.once('end',()=>{ job.report.metrics.upstreamEnded = true; this.record(job,'upstream-end'); this.finish(job,mCancelled(job)?'cancelled':'completed',mCancelled(job)?'observed_after_cancel':'upstream_end'); });
        incoming.once('aborted',()=>{ if (!job.pending) { this.record(job,'upstream-interrupted'); this.finish(job,'error','upstream_interrupted','Upstream response ended unexpectedly'); } });
        incoming.on('error',()=>{ if (!job.pending) this.finish(job,'error','upstream_error','Upstream response failed'); });
        incoming.once('close',()=>{ job.report.metrics.upstreamClosed = true; });
      });
      job.request = outgoing;
      outgoing.on('error',error=>{
        if (error.code === 'ABORT_ERR') job.report.metrics.upstreamAborted = true;
        if (!job.pending) { this.record(job,'upstream-error'); this.finish(job,'error','upstream_error','Endpoint connection failed'); }
      });
      outgoing.once('close',()=>{ job.closed = true; job.report.metrics.upstreamClosed = true; this.record(job,'upstream-close'); if (!job.pending) this.finish(job,'error','upstream_closed','Upstream connection closed before completion'); this.finalize(job); });
      if (res.destroyed && job.report.configuration.policy === 'propagate') void this.stop(job,'cancelled','client_abort');
    } catch { void this.stop(job,'error','request_failed','Endpoint request could not start'); }
  }
  async handle(req,res,path) {
    if (!(path === '/api/workspaces' || path === '/api/workspaces/current' || path === '/api/profile-runs' || path.startsWith('/api/profile-runs/'))) return false;
    try {
      if (this.closing) throw new ApiError(503,'Server is shutting down');
      if (['POST','DELETE'].includes(req.method) && !this.allowOrigin(req)) throw new ApiError(403,'Same-origin or configured public origin required');
      if (path === '/api/workspaces') {
        if (req.method !== 'POST') throw new ApiError(405,'POST required'); if (!this.workspaceCreation.take()) throw new ApiError(429,'Workspace creation rate budget exhausted');
        const value = await readJSON(req); if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new ApiError(400,'Workspace request must be an empty object'); send(res,201,this.store.createWorkspace()); return true;
      }
      const owner = this.auth(req);
      if (path === '/api/workspaces/current') {
        if (req.method !== 'DELETE') throw new ApiError(405,'DELETE required');
        await Promise.all([...this.jobs.values()].filter(j=>j.owner===owner).map(j=>this.stop(j,'interrupted','workspace_deleted'))); this.store.deleteWorkspace(owner); this.workspaceBudget.delete(owner); send(res,204); return true;
      }
      if (path === '/api/profile-runs') {
        if (req.method === 'POST') send(res,201,await this.create(owner,await readJSON(req)));
        else if (req.method === 'GET') { const rows = this.store.list(owner).map(row=>{ const job=this.jobs.get(row.id); if(!job)return row;const {events,...r}=this.snapshot(job);return r; }); send(res,200,{runs:rows,count:rows.length}); }
        else throw new ApiError(405,'GET or POST required'); return true;
      }
      const parts = /^\/api\/profile-runs\/([^/]+)(?:\/(stream|export))?$/.exec(path);
      if (!parts || !UUID.test(parts[1])) throw new ApiError(404,'Run not found');
      const id = parts[1], stored = this.store.get(owner,id); if(!stored)throw new ApiError(404,'Run not found'); const job=this.jobs.get(id);
      if (req.method === 'DELETE' && !parts[2]) { if(job)await this.stop(job,'interrupted','run_deleted');this.store.deleteRun(owner,id);send(res,204);return true; }
      if (req.method !== 'GET') throw new ApiError(405,'GET or DELETE required');
      if(parts[2]==='stream'){if(!job)throw new ApiError(409,'Stream is single-use or no longer available');this.stream(job,req,res);return true;}
      const report=job?this.snapshot(job):stored;if(parts[2]==='export')res.setHeader('content-disposition',`attachment; filename="stopline-${id}.json"`);send(res,200,report);return true;
    } catch(error) { if(res.headersSent)res.destroy();else send(res,error instanceof ApiError?error.status:(error.code==='ERR_SQLITE_ERROR' && /full/i.test(error.message)?507:503),{error:error instanceof ApiError?error.message:'Private workspace storage is unavailable'}); return true; }
  }
  async close() { if(this.shutdown)return this.shutdown; this.closing=true;this.shutdown=(async()=>{await Promise.allSettled([...this.admissionTasks]);await Promise.all([...this.jobs.values()].map(job=>this.stop(job,'interrupted','server_shutdown')));this.store.close();})();return this.shutdown; }
}
function mCancelled(job){return job.report.metrics.clientCancelledAtMs!==null;}
