/** Pure presentation decisions; values originate in the lab, never simulated here. */
export const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
export function cleanResources(snapshot) {
  return Boolean(snapshot) && ['activeProviderJobs', 'activeProxyRequests', 'activeTimers', 'openSockets', 'listeningServers']
    .every(key => snapshot[key] === 0);
}

export function outcomeFor(run) {
  if (!run) return { tone: 'idle', title: 'Ready when you are', description: 'The counters and timeline will populate with observed server events.' };
  if (run.phase === 'creating') return { tone: 'active', title: 'Opening a new experiment', description: 'Creating the run and connecting your browser to its one-use stream.' };
  if (run.creationError) return { tone: 'error', title: 'The run could not start', description: run.creationError };
  if (run.observationError) return { tone: 'warning', title: 'Observation interrupted', description: run.observationError + ' Cleanup has not been confirmed. Download the last available evidence or try a new run.' };
  const server = run.latest, metrics = server?.metrics;
  if (server?.cleanupForced) return { tone: 'warning', title: 'Safety cleanup stopped this run', description: `The server reached a ${server.status === 'timeout' ? 'deadline' : 'safety limit'}. Forced cleanup is not evidence that the chosen cancellation policy stopped work.` };
  if (server && ['failed', 'timeout', 'shutdown', 'expired'].includes(server.status))
    return { tone: 'error', title: 'The server ended this experiment', description: server.error || `Server status: ${server.status}. The recorded evidence is available below.` };
  if (run.cancelRequested) {
    if (!run.streamDone) return { tone: 'active', title: 'Closing the client connection', description: 'AbortController has been signaled. Waiting for the stream reader to close.' };
    if (metrics?.providerCancellationObserved && !server?.cleanupForced)
      return { tone: 'success', title: 'Cancellation reached the provider', description: `${metrics.providerUnitsAfterCancel ?? 0} work units observed after client close. ${server.terminal && cleanResources(server.cleanup) ? 'Provider work settled and resource cleanup is confirmed.' : 'Watching the remaining resources settle.'}` };
    if (metrics?.activeProviderJobs > 0) return { tone: 'warning', title: 'Client stopped. Provider still working.', description: `${metrics.providerUnitsAfterCancel ?? 0} additional units observed after the client closed. The timeline continues until work and cleanup settle.` };
    if (server?.terminal) return { tone: 'warning', title: 'Client stopped. Provider work finished.', description: `${metrics?.providerUnitsAfterCancel ?? 0} units observed after client close. No policy-driven provider cancellation was observed.${cleanResources(server.cleanup) ? ' Resource cleanup is confirmed.' : ''}` };
    return { tone: 'active', title: 'Client closed. Following the work.', description: 'Polling observed server metrics to distinguish cancellation from work that continues upstream.' };
  }
  if (run.streamError) return { tone: 'error', title: 'The stream was interrupted', description: `${run.streamError} Server observations continue so cleanup can be verified.` };
  if (server?.terminal) return { tone: cleanResources(server.cleanup) ? 'success' : 'warning', title: 'Run complete', description: `${metrics?.providerUnits ?? 0} provider units observed. ${cleanResources(server.cleanup) ? 'All experiment resources have settled and closed.' : 'The final cleanup snapshot has not confirmed zero active resources.'}` };
  return { tone: 'active', title: run.receivedUnits ? 'The stream is live' : 'Waiting for the first work unit', description: run.receivedUnits ? 'Cancel the stream to observe whether provider work stops or continues.' : 'The real HTTP connection is open. Initial delay and scheduling affect when data arrives.' };
}

export class UnitLines {
  constructor(totalUnits) { this.pending = ''; this.lastUnit = 0; this.totalUnits = totalUnits; }
  push(text) {
    this.pending += text;
    if (this.pending.length > 16384) throw new Error('Stream line exceeded the browser display limit.');
    const lines = [];
    let split;
    while ((split = this.pending.indexOf('\n')) >= 0) {
      const raw = this.pending.slice(0, split);
      this.pending = this.pending.slice(split + 1);
      const match = /^(\d{1,4}):x{1,4096}$/.exec(raw);
      if (!match || Number(match[1]) !== this.lastUnit + 1 || Number(match[1]) > this.totalUnits)
        throw new Error('The stream did not match the controlled work-unit contract.');
      this.lastUnit = Number(match[1]);
      lines.push({ unit: this.lastUnit, raw });
    }
    return lines;
  }
  finish() { if (this.pending) throw new Error('The stream ended in the middle of a work unit.'); }
}

export function checkedRunLinks(value, origin) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id ?? ''))
    throw new Error('The server returned an invalid run identifier.');
  const base = `/api/runs/${value.id}`;
  for (const [field, path] of [['streamUrl', `${base}/stream`], ['statusUrl', base]]) {
    const url = new URL(value[field], origin);
    if (url.origin !== origin || url.pathname !== path || url.search || url.hash)
      throw new Error('The server returned an unexpected experiment URL.');
  }
  return { id: value.id, streamUrl: `${base}/stream`, statusUrl: base };
}
