import test from 'node:test';
import assert from 'node:assert/strict';
import { createLab, consume, runExperiment } from '../src/lab.mjs';

function assertSettled(result) {
  assert.equal(result.metrics.activeTimers, 0);
  assert.equal(result.metrics.activeProviderJobs, 0);
  assert.equal(result.metrics.activeProxyRequests, 0);
  assert.equal(result.client.activePauseTimers, 0);
  assert.equal(result.cleanup.activeTimers, 0);
  assert.equal(result.cleanup.activeProviderJobs, 0);
  assert.equal(result.cleanup.activeProxyRequests, 0);
  assert.equal(result.cleanup.openSockets, 0);
  assert.equal(result.cleanup.listeningServers, 0);
}

test('normal stream completes through two real HTTP connections', async () => {
  const result = await runExperiment({ cancelAfterUnits: null, totalUnits: 6, intervalMs: 2 });
  assert.equal(result.client.status, 'complete');
  assert.equal(result.client.receivedUnits, 6);
  assert.equal(result.metrics.providerUnits, 6);
  assert.equal(result.metrics.propagatedAborts, 0);
  assert.equal(result.metrics.providerCompleted, 1);
  assertSettled(result);
});

test('midstream cancellation reduces cooperative upstream work versus naive draining', async () => {
  const base = { totalUnits: 14, cancelAfterUnits: 3, intervalMs: 5 };
  const naive = await runExperiment({ ...base, policy: 'naive' });
  const propagated = await runExperiment({ ...base, policy: 'propagate' });
  assert.equal(naive.client.status, 'cancelled');
  assert.equal(naive.metrics.providerUnits, 14);
  assert.ok(naive.metrics.providerUnitsAfterCancel > 0);
  assert.equal(propagated.client.status, 'cancelled');
  assert.equal(propagated.metrics.propagatedAborts, 1);
  assert.equal(propagated.metrics.providerCancellationObserved, true);
  assert.ok(propagated.metrics.providerUnitsAfterCancel < naive.metrics.providerUnitsAfterCancel);
  assert.ok(propagated.metrics.providerUnits < base.totalUnits);
  assertSettled(naive); assertSettled(propagated);
});

test('cancel after provider accepts but before first unit clears pending application timer', async () => {
  const result = await runExperiment({ cancelAfterUnits: 0, initialDelayMs: 100, intervalMs: 5 });
  assert.equal(result.client.status, 'cancelled');
  assert.equal(result.metrics.providerUnits, 0);
  assert.equal(result.metrics.providerCancelled, 1);
  assertSettled(result);
});

test('noncooperative provider is a negative control: socket abort does not prove computation stopped', async () => {
  const result = await runExperiment({ providerBehavior: 'noncooperative', totalUnits: 8, cancelAfterUnits: 2, intervalMs: 3 });
  assert.equal(result.metrics.propagatedAborts, 1);
  assert.equal(result.metrics.providerPeerCloses, 1);
  assert.equal(result.metrics.providerCancelled, 0);
  assert.equal(result.metrics.providerCompleted, 1);
  assert.equal(result.metrics.providerUnits, 8);
  assert.ok(result.metrics.providerUnitsAfterCancel > 0);
  assert.equal(result.metrics.cancellationLatencyMs, null);
  assertSettled(result);
});

test('provider error reaches client as error, not successful completion or user cancellation', async () => {
  const result = await runExperiment({ cancelAfterUnits: null, failAt: 3, intervalMs: 3 });
  assert.equal(result.client.status, 'error');
  assert.equal(result.metrics.providerErrors, 1);
  assert.equal(result.metrics.providerUnits, 2);
  assert.equal(result.metrics.clientCancelAtMs, null);
  assert.ok(result.metrics.proxyErrors >= 1);
  assertSettled(result);
});

test('backpressure pause/drain path preserves all data', async () => {
  const result = await runExperiment({ cancelAfterUnits: null, totalUnits: 8, payloadBytes: 65536, intervalMs: 0, pauseMs: 2 });
  assert.equal(result.client.status, 'complete');
  assert.equal(result.client.receivedUnits, 8);
  assert.ok(result.metrics.providerBackpressure > 0);
  assert.ok(result.metrics.proxyBackpressure > 0);
  assertSettled(result);
});

test('abort while handling backpressure does not strand paused upstream', async () => {
  const result = await runExperiment({ totalUnits: 20, payloadBytes: 65536, intervalMs: 1, pauseMs: 2, cancelAfterUnits: 2 });
  assert.equal(result.client.status, 'cancelled');
  assert.equal(result.metrics.providerCancelled, 1);
  assertSettled(result);
});

test('explicit shutdown cleans active timer and is idempotent', async () => {
  const lab = await createLab({ initialDelayMs: 1000 });
  const client = consume(lab, { cancelAfterUnits: null });
  await lab.waitForProvider();
  await lab.close();
  await lab.close();
  const result = await client;
  assert.equal(result.status, 'error');
  assert.equal(lab.snapshot().activeTimers, 0);
  assert.equal(lab.snapshot().activeProviderJobs, 0);
  assert.equal(lab.snapshot().activeProxyRequests, 0);
  assert.equal(lab.snapshot().openSockets, 0);
  assert.equal(lab.snapshot().listeningServers, 0);
});

test('concurrent close callers share the completed shutdown rather than returning early', async () => {
  const lab = await createLab({ initialDelayMs: 1000 });
  const client = consume(lab, { cancelAfterUnits: null });
  await lab.waitForProvider();
  const first = lab.close();
  const second = lab.close();
  assert.strictEqual(first, second);
  await second;
  const snapshot = lab.snapshot();
  assert.equal(snapshot.activeTimers, 0);
  assert.equal(snapshot.activeProviderJobs, 0);
  assert.equal(snapshot.activeProxyRequests, 0);
  assert.equal(snapshot.openSockets, 0);
  assert.equal(snapshot.listeningServers, 0);
  await first;
  assert.equal((await client).status, 'error');
});

test('accepted six-second initial delay completes under the derived idle deadline', { timeout: 10000 }, async () => {
  const result = await runExperiment({ policy: 'naive', initialDelayMs: 6000, totalUnits: 1, cancelAfterUnits: 0 });
  assert.equal(result.client.status, 'cancelled');
  assert.equal(result.metrics.providerCompleted, 1);
  assert.equal(result.metrics.providerUnits, 1);
  assert.equal(result.metrics.providerUnitsAfterCancel, 1);
  assertSettled(result);
});

test('invalid fixture configuration is rejected', async () => {
  for (const options of [{ policy: 'unknown' }, { totalUnits: -1 }, { intervalMs: NaN }, { failAt: 50 }, { payloadBytes: 2 }]) {
    await assert.rejects(createLab(options));
  }
});
