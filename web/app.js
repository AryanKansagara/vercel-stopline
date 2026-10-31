import { checkedRunLinks, cleanResources, nonnegative, outcomeFor, UnitLines } from './model.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['run-form','configuration-fields','run-button','run-label','cancel-button','total-units',
  'units-output','interval','interval-output','initial-delay','behavior-help','received-count','before-count',
  'after-count','abort-count','connection-badge','stream-output','byte-count','outcome','outcome-icon',
  'outcome-title','outcome-description','show-unit-events','event-list','event-count','cleanup-label',
  'cleanup-values','run-identity','reset-button','download-button','announcement'].map(id => [id, $(id)]));
const numberFormat = new Intl.NumberFormat('en-US');
const MAX_OBSERVATION_MS = 30000;
let current = null;
let serial = 0;

const isCurrent = run => current === run && run.serial === serial && !run.disposed;
const busy = run => Boolean(run) && (run.phase === 'creating' || (!run.creationError && !run.observationError && (!run.latest?.terminal || !run.streamDone)));
const formatted = value => nonnegative(value) === null ? '—' : numberFormat.format(value);
function announce(message) { ui.announcement.textContent = message; }
function emptyConsole() {
  const wrapper = document.createElement('div'); wrapper.className = 'empty-console';
  const icon = document.createElement('span'); icon.className = 'empty-terminal'; icon.setAttribute('aria-hidden','true'); icon.textContent = '›_';
  const title = document.createElement('strong'); title.textContent = 'Every stream has a story.';
  const description = document.createElement('p'); description.textContent = 'Start a run, then cancel to see where the work stops.';
  const hint = document.createElement('span'); hint.className = 'console-hint'; hint.textContent = "await fetch('/api/runs/…/stream')";
  wrapper.append(icon, title, description, hint); ui['stream-output'].replaceChildren(wrapper);
}
function controls() {
  const active = busy(current);
  ui['configuration-fields'].disabled = active;
  ui['run-button'].disabled = active;
  ui['run-label'].textContent = current?.phase === 'creating' ? 'Starting…' : active ? 'Run in progress' : current ? 'Run again' : 'Start streaming';
  ui['cancel-button'].disabled = !current?.id || current.streamDone || current.cancelRequested;
  ui['reset-button'].disabled = !current || active;
  ui['download-button'].disabled = !current?.latest;
  ui['run-form'].setAttribute('aria-busy', String(active));
}
function render() {
  const run = current, server = run?.latest, metrics = server?.metrics;
  ui['received-count'].textContent = formatted(run?.receivedUnits ?? 0);
  ui['before-count'].textContent = metrics ? formatted(Math.max(0, metrics.providerUnits - metrics.providerUnitsAfterCancel)) : '—';
  ui['after-count'].textContent = metrics ? formatted(metrics.providerUnitsAfterCancel) : '—';
  ui['abort-count'].textContent = metrics ? formatted(metrics.propagatedAborts) : '—';
  ui['byte-count'].textContent = `${formatted(run?.receivedBytes ?? 0)} bytes received`;
  const view = outcomeFor(run);
  ui.outcome.className = `outcome ${view.tone === 'idle' ? 'outcome-idle' : `is-${view.tone}`}`;
  ui['outcome-title'].textContent = view.title;
  ui['outcome-description'].textContent = view.description;
  ui['outcome-icon'].textContent = ({ idle: '◌', active: '◌', success: '✓', warning: '↗', error: '!' })[view.tone];
  if (run && run.lastAnnouncedTitle !== view.title) { run.lastAnnouncedTitle = view.title; announce(`${view.title}. ${view.description}`); }
  const badge = ui['connection-badge'];
  badge.className = 'connection-badge';
  let badgeLabel = 'Idle';
  if (run?.creationError || run?.streamError) { badgeLabel = 'Stream error'; badge.classList.add('is-error'); }
  else if (run?.cancelRequested && run.streamDone) { badgeLabel = 'Client closed'; badge.classList.add('is-closed'); }
  else if (run?.streamDone) { badgeLabel = 'Complete'; }
  else if (run?.id) { badgeLabel = run.receivedUnits ? 'Streaming' : 'Connected'; badge.classList.add('is-streaming'); }
  else if (run) badgeLabel = 'Connecting';
  const dot = document.createElement('i'); badge.replaceChildren(dot, document.createTextNode(badgeLabel));
  const snapshot = server?.cleanup ?? metrics;
  const confirmed = Boolean(server?.terminal) && cleanResources(server.cleanup);
  const cleanupBar = ui['cleanup-label'].parentElement;
  cleanupBar.classList.toggle('is-clean', confirmed);
  const cleanupDot = document.createElement('i'); cleanupDot.className = 'cleanup-indicator';
  ui['cleanup-label'].replaceChildren(cleanupDot, document.createTextNode(confirmed ? 'Cleanup confirmed' : run?.observationError ? 'Cleanup unconfirmed' : server?.cleanup ? 'Cleanup incomplete' : metrics ? 'Watching resources settle' : 'Cleanup not started'));
  ui['cleanup-values'].textContent = `Jobs ${formatted(snapshot?.activeProviderJobs)}  Timers ${formatted(snapshot?.activeTimers)}  Sockets ${formatted(snapshot?.openSockets)}`;
  ui['run-identity'].textContent = run?.id ? `RUN ${run.id.slice(0, 8)} · ${server?.status ?? 'connecting'}` : 'Evidence stays in this session.';
  controls();
}

const eventNames = {
  'provider-start': 'Provider generation started', 'proxy-start': 'Proxy request started',
  'client-cancel': 'Client disconnect observed', 'proxy-client-close': 'Proxy observed client close',
  'proxy-abort-upstream': 'Proxy forwarded upstream abort', 'provider-peer-close': 'Provider connection closed',
  'provider-cancelled': 'Provider acknowledged cancellation', 'provider-complete': 'Provider work completed',
  'provider-settled': 'Provider job settled', 'proxy-settled': 'Proxy request settled',
  'provider-error': 'Provider error observed', 'proxy-upstream-error': 'Proxy upstream error observed',
};
function renderEvents() {
  const includeUnits = ui['show-unit-events'].checked;
  const events = (current?.latest?.events ?? []).filter(event => includeUnits || event.kind !== 'provider-unit');
  const list = ui['event-list'];
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  const fragment = document.createDocumentFragment();
  for (const event of events) {
    const row = document.createElement('li');
    row.className = /cancel|abort|close/.test(event.kind) ? 'event-cancel' : /settled|complete/.test(event.kind) ? 'event-settled' : event.kind === 'provider-unit' ? 'event-unit' : '';
    const dot = document.createElement('span'); dot.className = 'event-dot'; dot.setAttribute('aria-hidden','true');
    const label = document.createElement('span');
    label.textContent = event.kind === 'provider-unit' ? `Provider produced unit ${event.unit}` : eventNames[event.kind] ?? String(event.kind).slice(0, 100).replaceAll('-', ' ');
    const time = document.createElement('span'); time.className = 'event-time';
    time.textContent = nonnegative(event.atMs) === null ? '—' : `+${event.atMs.toFixed(1)} ms`;
    row.append(dot, label, time); fragment.append(row);
  }
  if (!events.length) { const empty = document.createElement('li'); empty.className = 'timeline-empty'; empty.textContent = 'Waiting for the first observed event.'; fragment.append(empty); }
  list.replaceChildren(fragment);
  ui['event-count'].textContent = String(events.length);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function appendLines(run, lines) {
  if (!isCurrent(run) || !lines.length) return;
  const output = ui['stream-output'];
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  if (!run.receivedUnits) output.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    run.receivedUnits++;
    const row = document.createElement('div'); row.className = 'stream-line';
    const number = document.createElement('span'); number.setAttribute('aria-hidden','true'); number.textContent = String(run.receivedUnits).padStart(3, '0');
    const code = document.createElement('code'); code.textContent = line.raw;
    row.append(number, code); fragment.append(row);
  }
  output.append(fragment);
  if (atBottom) output.scrollTop = output.scrollHeight;
  render();
}
function endMarker(run) {
  if (!isCurrent(run) || run.markerAdded) return;
  run.markerAdded = true;
  if (!run.receivedUnits) ui['stream-output'].replaceChildren();
  const marker = document.createElement('div'); marker.className = 'stream-end-marker';
  marker.textContent = run.cancelRequested ? '↳ Client fetch aborted. Server observation continues.' : run.streamError ? `↳ ${run.streamError}` : '↳ Response stream reached its end.';
  ui['stream-output'].append(marker);
}
async function responseError(response) {
  let message = `Request failed with HTTP ${response.status}.`;
  try { const body = await response.json(); if (typeof body.error === 'string') message = body.error.slice(0, 220); } catch {}
  if (response.status === 429) message = `The lab is busy or its run budget is exhausted. ${message} Wait before trying again.`;
  if (response.status === 503) message = `The lab is temporarily unavailable. ${message}`;
  return new Error(message);
}

async function readStream(run) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = new UnitLines(run.configuration.totalUnits);
  try {
    const response = await fetch(run.streamUrl, { signal: run.streamController.signal, cache: 'no-store' });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('This browser did not provide a readable response stream.');
    if (!isCurrent(run)) { await response.body.cancel(); return; }
    run.reader = response.body.getReader();
    for (;;) {
      const { value, done } = await run.reader.read();
      if (!isCurrent(run)) return;
      if (done) { appendLines(run, parser.push(decoder.decode())); parser.finish(); break; }
      run.receivedBytes += value.byteLength; run.receivedChunks++;
      if (run.receivedBytes > 131072) throw new Error('The stream exceeded the browser evidence limit.');
      appendLines(run, parser.push(decoder.decode(value, { stream: true })));
      render();
    }
    run.streamOutcome = 'completed';
  } catch (error) {
    if (!isCurrent(run)) return;
    if (run.cancelRequested && run.streamController.signal.aborted) run.streamOutcome = 'cancelled';
    else {
      run.streamError = error instanceof Error ? error.message.slice(0, 240) : 'The stream could not be read.';
      run.streamOutcome = 'error';
      run.streamController.abort();
    }
  } finally {
    try { run.reader?.releaseLock(); } catch {}
    if (isCurrent(run)) { run.streamDone = true; endMarker(run); render(); }
  }
}

async function poll(run) {
  if (!isCurrent(run) || run.observationEnded) return;
  if (performance.now() - run.observationStarted > MAX_OBSERVATION_MS) {
    run.observationEnded = true;
    run.observationError = 'The 30-second observation window expired.';
    render(); return;
  }
  const controller = new AbortController(); run.statusController = controller;
  const timer = setTimeout(() => controller.abort(), 3500); run.statusDeadline = timer;
  let terminal = false;
  try {
    const response = await fetch(run.statusUrl, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw await responseError(response);
    const report = await response.json();
    if (!isCurrent(run)) return;
    if (report.id !== run.id || typeof report.terminal !== 'boolean' || !Array.isArray(report.events)
        || !['queued', 'running', 'settling', 'completed', 'cancelled', 'expired', 'failed', 'timeout', 'shutdown'].includes(report.status))
      throw new Error('The server returned an unexpected status report.');
    run.latest = report; run.pollFailures = 0;
    terminal = report.terminal;
    if (terminal) run.observationEnded = true;
    renderEvents(); render();
  } catch (error) {
    if (!isCurrent(run) || run.disposed) return;
    run.pollFailures++;
    if (run.pollFailures >= 5) {
      run.observationEnded = true;
      run.observationError = 'Five consecutive status requests failed.';
      render(); return;
    }
    announce(`Status request failed. Retrying observation (${run.pollFailures} of 5).`);
  } finally {
    clearTimeout(timer); run.statusDeadline = null;
    if (isCurrent(run) && !terminal && !run.observationEnded) run.pollTimer = setTimeout(() => void poll(run), 250);
  }
}

function dispose(run) {
  if (!run || run.disposed) return;
  run.disposed = true;
  clearTimeout(run.pollTimer); clearTimeout(run.statusDeadline); clearTimeout(run.createDeadline);
  run.createController.abort(); run.streamController.abort(); run.statusController?.abort();
  try { void run.reader?.cancel().catch(() => {}); } catch {}
  if (run.downloadUrl) URL.revokeObjectURL(run.downloadUrl);
}

ui['run-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (busy(current) || !ui['run-form'].reportValidity()) return;
  dispose(current);
  const fields = new FormData(ui['run-form']);
  const configuration = { policy: fields.get('policy'), providerBehavior: fields.get('providerBehavior'),
    totalUnits: Number(fields.get('totalUnits')), intervalMs: Number(fields.get('intervalMs')), initialDelayMs: Number(fields.get('initialDelayMs')) };
  const run = { serial: ++serial, phase: 'creating', configuration, receivedUnits: 0, receivedBytes: 0,
    receivedChunks: 0, cancelRequested: false, streamDone: false, streamOutcome: null, pollFailures: 0,
    latest: null, disposed: false, createController: new AbortController(), streamController: new AbortController(),
    startedAt: new Date().toISOString() };
  current = run; emptyConsole(); renderEvents(); render();
  run.createDeadline = setTimeout(() => run.createController.abort(), 5000);
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configuration), signal: run.createController.signal });
    if (!response.ok) throw await responseError(response);
    const links = checkedRunLinks(await response.json(), window.location.origin);
    if (!isCurrent(run)) return;
    Object.assign(run, links); run.phase = 'observing'; run.observationStarted = performance.now();
    render();
    // Polling and the stream have separate controllers: Cancel closes only the
    // streaming connection, keeping actual provider/cleanup evidence observable.
    void readStream(run); void poll(run);
  } catch (error) {
    if (!isCurrent(run)) return;
    run.phase = 'failed'; run.streamDone = true; run.observationEnded = true;
    run.creationError = run.createController.signal.aborted ? 'The run creation request timed out. No connected stream was established.' : error instanceof Error ? error.message.slice(0, 260) : 'The lab could not be reached.';
    render();
  } finally { clearTimeout(run.createDeadline); run.createDeadline = null; }
});

ui['cancel-button'].addEventListener('click', () => {
  const run = current;
  if (!run?.id || run.streamDone || run.cancelRequested) return;
  run.cancelRequested = true;
  run.browserCancelAt = new Date().toISOString();
  run.streamController.abort();
  render();
});
ui['reset-button'].addEventListener('click', () => {
  if (busy(current)) return;
  dispose(current); current = null; serial++;
  emptyConsole(); renderEvents(); render(); announce('Run cleared. Ready for a new experiment.');
});
ui['download-button'].addEventListener('click', () => {
  const run = current;
  if (!run?.latest) return;
  const evidence = { schemaVersion: 1, scope: 'controlled_generator_over_real_HTTP_not_inference_or_vendor_billing',
    downloadedAt: new Date().toISOString(), configuration: run.configuration,
    browser: { startedAt: run.startedAt, cancelRequested: run.cancelRequested, cancelAt: run.browserCancelAt ?? null,
      streamOutcome: run.streamOutcome, receivedUnits: run.receivedUnits, receivedBytes: run.receivedBytes,
      receivedChunks: run.receivedChunks, streamError: run.streamError ?? null, observationError: run.observationError ?? null },
    server: run.latest };
  if (run.downloadUrl) URL.revokeObjectURL(run.downloadUrl);
  run.downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = run.downloadUrl; link.download = `stopline-${run.id.slice(0, 8)}.json`;
  document.body.append(link); link.click(); link.remove();
  announce('Downloaded the current browser and server observations as JSON.');
});
ui['show-unit-events'].addEventListener('change', renderEvents);
ui['total-units'].addEventListener('input', () => { ui['units-output'].textContent = `${ui['total-units'].value} units`; });
ui.interval.addEventListener('input', () => { ui['interval-output'].textContent = `${ui.interval.value} ms`; });
document.querySelectorAll('input[name="providerBehavior"]').forEach(input => input.addEventListener('change', () => {
  ui['behavior-help'].textContent = input.value === 'cooperative' ? 'Stops generating when its connection closes.' : 'Continues its bounded work after its connection closes.';
}));
window.addEventListener('pagehide', () => { dispose(current); serial++; });
render();
