import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { runExperiment } from './src/lab.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string' }, repeats: { type: 'string', default: '3' }, help: { type: 'boolean' } },
});
if (values.help) {
  console.log('node cli.mjs compare [--repeats 3] [--output run.json]');
} else {
  if (positionals.length > 1 || (positionals[0] && positionals[0] !== 'compare')) throw new Error('Expected compare command');
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be 1..20');
  const cases = [
    ['before-first-unit', { cancelAfterUnits: 0, initialDelayMs: 40 }],
    ['midstream', { cancelAfterUnits: 3 }],
    ['normal-completion', { cancelAfterUnits: null }],
    ['provider-error', { cancelAfterUnits: null, failAt: 5 }],
    ['provider-ignores-cancel', { cancelAfterUnits: 3, providerBehavior: 'noncooperative' }],
  ];
  const runs = [];
  for (const [scenario, options] of cases) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const policy of repeat % 2 ? ['propagate', 'naive'] : ['naive', 'propagate']) {
        runs.push({ scenario, repeat, ...await runExperiment({ policy, ...options }) });
      }
    }
  }
  const summary = cases.map(([scenario]) => ({
    scenario,
    policies: Object.fromEntries(['naive', 'propagate'].map((policy) => {
      const selected = runs.filter((r) => r.scenario === scenario && r.configuration.policy === policy);
      return [policy, {
        runs: selected.length,
        providerUnits: selected.reduce((n, r) => n + r.metrics.providerUnits, 0),
        unitsAfterCancel: selected.reduce((n, r) => n + r.metrics.providerUnitsAfterCancel, 0),
        observedProviderCancellations: selected.filter((r) => r.metrics.providerCancellationObserved).length,
        resourcesSettled: selected.every((r) => !r.cleanup.activeTimers && !r.cleanup.activeProviderJobs && !r.cleanup.activeProxyRequests && !r.cleanup.openSockets && !r.cleanup.listeningServers),
      }];
    })),
  }));
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform },
    notice: 'Actual local HTTP streaming and disconnection; authored generator work. No Vercel runtime, AI inference, or provider billing measurements.',
    repeats, summary, runs,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(values.output, json);
  console.log(JSON.stringify({ ...report, runs: `${runs.length} detailed runs${values.output ? ' written to ' + values.output : '; use --output to preserve event evidence'}` }, null, 2));
}
