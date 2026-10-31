/** Real loopback HTTP; deterministic generator work, not an AI inference benchmark. */
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';

const defaults = {
  policy: 'propagate', providerBehavior: 'cooperative', totalUnits: 12,
  intervalMs: 8, initialDelayMs: 8, payloadBytes: 32, failAt: null,
};

function validate(options) {
  if (!['propagate', 'naive'].includes(options.policy)) throw new Error('Unknown policy');
  if (!['cooperative', 'noncooperative'].includes(options.providerBehavior)) throw new Error('Unknown provider behavior');
  for (const [name, min, max] of [
    ['totalUnits', 1, 1000], ['intervalMs', 0, 1000], ['initialDelayMs', 0, 10000], ['payloadBytes', 8, 1048576],
  ]) {
    if (!Number.isInteger(options[name]) || options[name] < min || options[name] > max) throw new Error(`Invalid ${name}`);
  }
  if (options.failAt !== null && (!Number.isInteger(options.failAt) || options.failAt < 1 || options.failAt > options.totalUnits)) throw new Error('Invalid failAt');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

export async function createLab(input = {}) {
  const options = { ...defaults, ...input };
  validate(options);
  const startedAt = performance.now();
  const emitter = new EventEmitter();
  const events = [];
  const timers = new Set();
  const providerControllers = new Set();
  const proxyControllers = new Set();
  const providerJobs = new Set();
  const sockets = new Set();
  const metrics = {
    providerStarted: 0, providerCompleted: 0, providerCancelled: 0, providerErrors: 0,
    providerUnits: 0, providerWrites: 0, providerPeerCloses: 0,
    propagatedAborts: 0, proxyErrors: 0, activeProxyRequests: 0,
    providerBackpressure: 0, proxyBackpressure: 0, clientCancelAtMs: null, clientCancelSequence: null,
  };
  let closed = false;
  function record(kind, data = {}) {
    const event = { sequence: events.length, atMs: +(performance.now() - startedAt).toFixed(3), kind, provenance: 'observed', ...data };
    events.push(event);
    emitter.emit(kind, event);
    return event;
  }
  function sleep(ms, signal) {
    if (signal.aborted) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer); timers.delete(timer); signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(new Error('cancelled'));
      const timer = setTimeout(() => finish(), ms);
      timers.add(timer);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function drainOrClose(response, signal) {
    if (response.destroyed || signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value) => {
        response.off('drain', drained); response.off('close', stopped);
        signal.removeEventListener('abort', stopped); resolve(value);
      };
      const drained = () => finish(true);
      const stopped = () => finish(false);
      response.once('drain', drained); response.once('close', stopped);
      signal.addEventListener('abort', stopped, { once: true });
    });
  }
  const provider = http.createServer({ highWaterMark: 1024 }, (request, response) => {
    if (request.url !== '/generate') { response.writeHead(404).end(); return; }
    const controller = new AbortController();
    providerControllers.add(controller);
    metrics.providerStarted += 1;
    record('provider-start');
    response.on('error', () => {});
    response.on('close', () => {
      if (!response.writableFinished) {
        metrics.providerPeerCloses += 1;
        record('provider-peer-close');
        if (options.providerBehavior === 'cooperative') controller.abort();
      }
    });
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    const job = (async () => {
      try {
        await sleep(options.initialDelayMs, controller.signal);
        for (let unit = 1; unit <= options.totalUnits; unit++) {
          if (unit > 1) await sleep(options.intervalMs, controller.signal);
          if (unit === options.failAt) throw new Error('Injected provider error');
          metrics.providerUnits += 1;
          record('provider-unit', { unit });
          // A noncooperative provider may keep computing even after its socket dies.
          if (!response.destroyed) {
            const chunk = `${unit}:` + 'x'.repeat(options.payloadBytes) + '\n';
            metrics.providerWrites += 1;
            if (!response.write(chunk)) {
              metrics.providerBackpressure += 1;
              await drainOrClose(response, controller.signal);
            }
          }
        }
        metrics.providerCompleted += 1;
        record('provider-complete');
        if (!response.destroyed) response.end();
      } catch (error) {
        if (controller.signal.aborted) {
          metrics.providerCancelled += 1;
          record('provider-cancelled');
        } else {
          metrics.providerErrors += 1;
          record('provider-error', { message: error.message });
          response.destroy(error);
        }
      } finally {
        providerControllers.delete(controller);
        record('provider-settled');
      }
    })();
    providerJobs.add(job);
    job.finally(() => providerJobs.delete(job));
  });
  const providerUrl = await listen(provider);

  const proxy = http.createServer({ highWaterMark: 1024 }, (request, response) => {
    if (request.url !== '/stream') { response.writeHead(404).end(); return; }
    const controller = new AbortController();
    proxyControllers.add(controller);
    metrics.activeProxyRequests += 1;
    record('proxy-start');
    let upstreamResponse;
    let settled = false;
    let aborted = false;
    let drainHandler;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (drainHandler) response.off('drain', drainHandler);
      proxyControllers.delete(controller);
      metrics.activeProxyRequests -= 1;
      record('proxy-settled');
    };
    const upstreamError = (error) => {
      if (!aborted && !settled) {
        metrics.proxyErrors += 1;
        record('proxy-upstream-error', { message: error.message });
      }
      if (!response.destroyed) response.destroy(error);
      settle();
    };
    const upstream = http.request(providerUrl + '/generate', { signal: controller.signal, agent: false }, (incoming) => {
      upstreamResponse = incoming;
      response.writeHead(incoming.statusCode, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.flushHeaders();
      incoming.on('data', (chunk) => {
        if (response.destroyed) return; // Naive policy drains/discards rather than aborting provider work.
        if (!response.write(chunk)) {
          metrics.proxyBackpressure += 1;
          incoming.pause();
          drainHandler = () => { drainHandler = undefined; incoming.resume(); };
          response.once('drain', drainHandler);
        }
      });
      incoming.on('end', () => { if (!response.destroyed) response.end(); settle(); });
      incoming.on('aborted', () => upstreamError(new Error('Provider stream aborted')));
      incoming.on('error', upstreamError);
    });
    response.on('error', () => {});
    response.on('close', () => {
      if (drainHandler) { response.off('drain', drainHandler); drainHandler = undefined; }
      upstreamResponse?.resume(); // Never strand a paused upstream when downstream goes away.
      if (!response.writableFinished && !settled) {
        record('proxy-client-close');
        if (options.policy === 'propagate') {
          aborted = true;
          metrics.propagatedAborts += 1;
          record('proxy-abort-upstream');
          controller.abort();
        }
      }
    });
    upstream.on('error', upstreamError);
    upstream.setTimeout(10000, () => upstream.destroy(new Error('Upstream idle timeout')));
    upstream.end();
  });
  const proxyUrl = await listen(proxy);
  for (const server of [provider, proxy]) {
    server.on('connection', (socket) => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    });
  }

  const lab = {
    options, events, metrics, proxyUrl, providerUrl,
    recordClientCancel() {
      if (metrics.clientCancelAtMs === null) {
        const event = record('client-cancel');
        metrics.clientCancelAtMs = event.atMs;
        metrics.clientCancelSequence = event.sequence;
      }
    },
    async waitForProvider() {
      if (metrics.providerStarted) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { emitter.off('provider-start', ready); reject(new Error('Provider start timeout')); }, 2000);
        const ready = () => { clearTimeout(timer); resolve(); };
        emitter.once('provider-start', ready);
      });
    },
    async waitForIdle(timeoutMs = 5000) {
      const deadline = performance.now() + timeoutMs;
      while (providerJobs.size || metrics.activeProxyRequests) {
        if (performance.now() >= deadline) throw new Error('Application resources did not settle');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
    snapshot() {
      const cancelAt = metrics.clientCancelAtMs;
      return {
        ...metrics,
        providerUnitsAfterCancel: cancelAt === null ? 0 : events.filter((e) => e.kind === 'provider-unit' && e.sequence > metrics.clientCancelSequence).length,
        activeProviderJobs: providerJobs.size, activeTimers: timers.size,
        openSockets: sockets.size, listeningServers: Number(provider.listening) + Number(proxy.listening),
        cancellationLatencyMs: cancelAt === null ? null : (() => {
          const acknowledgement = events.find((e) => e.kind === 'provider-cancelled' && e.atMs >= cancelAt);
          return acknowledgement ? +(acknowledgement.atMs - cancelAt).toFixed(3) : null;
        })(),
        providerCancellationObserved: metrics.providerCancelled > 0,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const c of proxyControllers) c.abort();
      for (const c of providerControllers) c.abort();
      const socketClosures = [...sockets].map((socket) => new Promise((resolve) => {
        if (socket.closed) { sockets.delete(socket); resolve(); return; }
        socket.once('close', resolve);
        socket.destroy();
      }));
      await Promise.allSettled([...providerJobs]);
      await Promise.all(socketClosures);
      await Promise.all([provider, proxy].map((server) => new Promise((resolve) => {
        server.close(resolve); server.closeAllConnections();
      })));
    },
  };
  return lab;
}

export async function consume(lab, { cancelAfterUnits = null, pauseMs = 0 } = {}) {
  if (cancelAfterUnits !== null && (!Number.isInteger(cancelAfterUnits) || cancelAfterUnits < 0)) throw new Error('Invalid cancellation threshold');
  if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 1000) throw new Error('Invalid pauseMs');
  let pauseTimer;
  let activePauseTimers = 0;
  const result = await new Promise((resolve) => {
    let response;
    let receivedUnits = 0;
    let receivedBytes = 0;
    let cancelled = false;
    let done = false;
    let buffer = '';
    const settle = (status, error = null) => {
      if (done) return;
      done = true;
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = undefined; activePauseTimers = 0; }
      resolve({ status, receivedUnits, receivedBytes, error, activePauseTimers });
    };
    const cancel = () => {
      if (done || cancelled) return;
      cancelled = true;
      lab.recordClientCancel();
      response?.destroy(); request.destroy();
      settle('cancelled');
    };
    const request = http.request(lab.proxyUrl + '/stream', { agent: false }, (incoming) => {
      response = incoming;
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf('\n')) >= 0) { receivedUnits += 1; buffer = buffer.slice(split + 1); }
        if (cancelAfterUnits !== null && receivedUnits >= cancelAfterUnits) { cancel(); return; }
        if (pauseMs) {
          incoming.pause();
          activePauseTimers = 1;
          pauseTimer = setTimeout(() => { pauseTimer = undefined; activePauseTimers = 0; incoming.resume(); }, pauseMs);
        }
      });
      incoming.on('end', () => settle('complete'));
      incoming.on('aborted', () => settle(cancelled ? 'cancelled' : 'error', cancelled ? null : 'Stream aborted'));
      incoming.on('error', (error) => settle(cancelled ? 'cancelled' : 'error', cancelled ? null : error.message));
    });
    request.on('error', (error) => settle(cancelled ? 'cancelled' : 'error', cancelled ? null : error.message));
    request.end();
    if (cancelAfterUnits === 0) lab.waitForProvider().then(cancel, (error) => { request.destroy(); settle('error', error.message); });
  });
  return result;
}

export async function runExperiment(options = {}) {
  const { cancelAfterUnits = 3, pauseMs = 0, ...labOptions } = options;
  const lab = await createLab(labOptions);
  const started = performance.now();
  let result;
  try {
    const client = await consume(lab, { cancelAfterUnits, pauseMs });
    await lab.waitForIdle();
    const metrics = lab.snapshot();
    result = {
      schemaVersion: 1,
      validation: 'real-loopback-http-with-controlled-generator',
      configuration: { ...lab.options, cancelAfterUnits, pauseMs, provenance: 'fixture' },
      client, metrics, events: lab.events,
      elapsedMs: +(performance.now() - started).toFixed(3),
      inferenceMeasured: false,
      providerBilling: 'not measured; fixture has no vendor billing',
    };
  } finally { await lab.close(); }
  result.cleanup = lab.snapshot();
  return result;
}
