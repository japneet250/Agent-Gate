import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  captureError,
  shutdownObservability,
  startObservability,
} from '@agentgate/observability';
import { resolveEvaluate, type EngineKind } from './engine/index.js';
import { loadScenarios } from './scenarios.js';
import { scoreSuite } from './score.js';
import { buildReport, byCategory, metricsFor, printFailures, printMetrics } from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(here, '..', 'report.json');

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

async function main() {
  const obs = startObservability('evals');
  const kindOverride = opt('engine') as EngineKind | undefined;
  const resolved = await resolveEvaluate(kindOverride);
  const scenarios = loadScenarios();
  const only = opt('category');
  const selected = only ? scenarios.filter((s) => s.category === only) : scenarios;
  const scenarioHash = createHash('sha256')
    .update(JSON.stringify(selected.map((s) => [s.id, s.toolName, s.toolArgs, s.expected])))
    .digest('hex')
    .slice(0, 12);

  console.log(
    `\nAgentGate eval harness — ${selected.length} scenarios, engine=${resolved.kind}${resolved.kind === 'stub' ? ' (stub: real engine not wired yet)' : ''}`,
  );
  console.log(
    `observability: sentry=${obs.sentry ? 'on' : 'off'} langfuse=${obs.langfuse ? 'on' : 'off'}`,
  );

  const suite = await scoreSuite({
    label: resolved.kind,
    evaluate: resolved.evaluate,
    scenarios: selected,
    path: 'rule',
    metadata: { engine: resolved.kind, category: only ?? 'all' },
  });

  const metrics = metricsFor(suite.rows);
  printMetrics(metrics, byCategory(suite.rows));
  printFailures(suite.rows, Number(opt('show-failures') ?? 15));

  const { latency } = suite;
  console.log(
    `\nLatency  mean ${latency.meanMs.toFixed(1)}ms  p50 ${latency.p50Ms}ms  p95 ${latency.p95Ms}ms  max ${latency.maxMs}ms`,
  );

  const report = buildReport({ suite, engine: resolved.kind, scenarioHash });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), REPORT_PATH)}`);

  await shutdownObservability();

  // --strict lets CI fail the build on a regression; off by default so the
  // harness stays usable while the real engine is still being built.
  const threshold = Number(opt('min-macro-f1') ?? 0);
  if (flag('strict') && metrics.macroF1 < threshold) {
    console.error(`\nmacro-F1 ${metrics.macroF1.toFixed(3)} below threshold ${threshold}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  captureError(err, { service: 'evals' });
  console.error(err);
  await shutdownObservability();
  process.exit(1);
});
