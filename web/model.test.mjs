import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRunLinks, cleanResources, outcomeFor, UnitLines } from './model.js';
const closed = { activeProviderJobs: 0, activeProxyRequests: 0, activeTimers: 0, openSockets: 0, listeningServers: 0 };

test('client abort alone never implies provider cancellation or cleanup', () => {
  const run = { phase: 'observing', cancelRequested: true, streamDone: true, latest: { terminal: false,
    status: 'settling', metrics: { activeProviderJobs: 1, providerUnitsAfterCancel: 7, propagatedAborts: 1 } } };
  const view = outcomeFor(run);
  assert.equal(view.tone, 'warning'); assert.match(view.title, /Provider still working/);
  assert.match(view.description, /7 additional units/);
  assert.equal(cleanResources({ ...closed, listeningServers: 1 }), false);
});
test('cooperative observation requires actual acknowledgement; forced cleanup has priority', () => {
  const run = { phase: 'observing', cancelRequested: true, streamDone: true, latest: { terminal: true,
    status: 'cancelled', cleanup: closed, metrics: { providerCancellationObserved: true, providerUnitsAfterCancel: 0 } } };
  assert.equal(outcomeFor(run).tone, 'success');
  assert.match(outcomeFor(run).description, /cleanup is confirmed/);
  run.latest.cleanupForced = true;
  assert.equal(outcomeFor(run).tone, 'warning');
  assert.match(outcomeFor(run).description, /not evidence/);
});
test('missing cleanup and observation failure never report success', () => {
  assert.equal(cleanResources(null), false);
  assert.equal(cleanResources({}), false);
  const run = { phase: 'observing', latest: { terminal: true, status: 'completed', metrics: { providerUnits: 48 }, cleanup: null } };
  assert.equal(outcomeFor(run).tone, 'warning');
  run.observationError = 'Polling timed out.';
  assert.match(outcomeFor(run).description, /Cleanup has not been confirmed/);
});
test('real unit lines survive arbitrary decoded chunk boundaries and multiple lines per chunk', () => {
  const wire = '1:xxxx\n2:xxxx\n3:xxxx\n';
  for (let width = 1; width <= wire.length; width++) {
    const parser = new UnitLines(3), units = [];
    for (let i = 0; i < wire.length; i += width) units.push(...parser.push(wire.slice(i, i + width)));
    parser.finish(); assert.deepEqual(units.map(line => line.unit), [1, 2, 3]);
  }
});
test('unexpected, out-of-sequence, oversized and truncated streams fail explicitly', () => {
  for (const input of ['2:xx\n', '1:<script>\n', '1:xx\n1:xx\n', 'x'.repeat(16385)])
    assert.throws(() => new UnitLines(3).push(input));
  const parser = new UnitLines(3); parser.push('1:xx'); assert.throws(() => parser.finish());
});
test('run URLs must match the exact same-origin single-use API contract', () => {
  const id = '12c555ee-1ebc-45c7-9a31-4d5e83060b99', path = `/api/runs/${id}`;
  const report = { id, streamUrl: `${path}/stream`, statusUrl: path };
  assert.deepEqual(checkedRunLinks(report, 'https://lab.example'), report);
  assert.throws(() => checkedRunLinks({ ...report, streamUrl: `https://other.example${path}/stream` }, 'https://lab.example'));
  assert.throws(() => checkedRunLinks({ ...report, statusUrl: `${path}?extra=1` }, 'https://lab.example'));
});
