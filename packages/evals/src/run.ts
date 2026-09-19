import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Decision, EvalResult } from '@agentgate/shared-types';
import { resolveEvaluate, type EngineKind } from './engine/index.js';
import { loadScenarios, materialise, type Scenario } from './scenarios.js';
import { computeMetrics, DECISIONS, type Metrics } from './metrics.js';
import {
  captureError,
  observeRun,
  shutdownObservability,
  startObservability,
} from '@agentgate/observability';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(here, '..', 'report.json');

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

type Row = {
  scenario: Scenario;
  result: EvalResult;
  predicted: Decision;
  correct: boolean;
};

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printMetrics(metrics: Metrics, byCategory: Map<string, Metrics>) {
  console.log('\nPer-decision-class');
  console.log(
    `  ${pad('class', 10)}${padL('support', 9)}${padL('pred', 7)}${padL('precision', 11)}${padL('recall', 9)}${padL('f1', 8)}`,
  );
  for (const c of metrics.perClass) {
    console.log(
      `  ${pad(c.decision, 10)}${padL(String(c.support), 9)}${padL(String(c.predicted), 7)}${padL(pct(c.precision), 11)}${padL(pct(c.recall), 9)}${padL(c.f1.toFixed(3), 8)}`,
    );
  }
  console.log(
    `\n  accuracy ${pct(metrics.accuracy)} (${metrics.correct}/${metrics.total})   macro-F1 ${metrics.macroF1.toFixed(3)}   weighted-F1 ${metrics.weightedF1.toFixed(3)}`,
  );

  console.log('\nConfusion (rows = expected, cols = predicted)');
  console.log(`  ${pad('', 12)}${DECISIONS.map((d) => padL(d, 10)).join('')}`);
  for (const e of DECISIONS) {
    console.log(
      `  ${pad(e, 12)}${DECISIONS.map((p) => padL(String(metrics.confusion[e][p]), 10)).join('')}`,
    );
  }

  // Most categories are single-label by construction, so accuracy plus the
  // spread of what was actually predicted says more here than a macro-F1.
  console.log('\nBy scenario category');
  console.log(
    `  ${pad('category', 12)}${padL('n', 5)}${padL('accuracy', 11)}   ${DECISIONS.map((d) => padL(`->${d}`, 11)).join('')}`,
  );
  for (const [cat, m] of byCategory) {
    const predicted = DECISIONS.map((d) =>
      padL(String(DECISIONS.reduce((n, e) => n + m.confusion[e][d], 0)), 11),
    ).join('');
    console.log(
      `  ${pad(cat, 12)}${padL(String(m.total), 5)}${padL(pct(m.accuracy), 11)}   ${predicted}`,
    );
  }
}

function printFailures(rows: Row[], limit: number) {
  const failures = rows.filter((r) => !r.correct);
  if (failures.length === 0) {
    console.log('\nNo mismatches.');
    return;
  }
  console.log(`\nMismatches (${failures.length}, showing up to ${limit})`);
  for (const f of failures.slice(0, limit)) {
    console.log(
      `  ${pad(f.scenario.id, 16)} expected ${pad(f.scenario.expected, 9)} got ${pad(f.predicted, 9)} risk=${padL(String(f.result.riskScore), 3)}  ${f.scenario.description}`,
    );
    console.log(`  ${pad('', 16)} └─ ${f.result.violatedPolicy ?? 'no policy'}: ${f.result.reasoning}`);
  }
}

async function main() {
  const obs = startObservability('evals');
  const kindOverride = opt('engine') as EngineKind | undefined;
  const { evaluate, kind } = await resolveEvaluate(kindOverride);
  const scenarios = loadScenarios();
  const only = opt('category');
  const selected = only ? scenarios.filter((s) => s.category === only) : scenarios;

  console.log(
    `\nAgentGate eval harness — ${selected.length} scenarios, engine=${kind}${kind === 'stub' ? ' (stub: real engine not wired yet)' : ''}`,
  );
  console.log(
    `observability: sentry=${obs.sentry ? 'on' : 'off'} langfuse=${obs.langfuse ? 'on' : 'off'}`,
  );

  const suiteId = `evalsuite_${Date.now()}`;
  const run = observeRun({
    sessionId: suiteId,
    agentId: 'eval-harness',
    name: 'agentgate.eval.suite',
    metadata: { engine: kind, scenarioCount: selected.length, category: only ?? 'all' },
  });

  const rows: Row[] = [];
  const latencies: number[] = [];

  for (const scenario of selected) {
    const { action, context } = materialise(scenario);
    const startedAt = performance.now();
    let result: EvalResult;
    try {
      result = await evaluate(action, context);
    } catch (err) {
      // A throwing engine is a failure, not a crash -- score it and keep going.
      captureError(err, { scenarioId: scenario.id, toolName: scenario.toolName });
      result = {
        riskScore: -1,
        decision: 'allow',
        reasoning: `evaluate() threw: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
    latencies.push(result.latencyMs ?? Math.round(performance.now() - startedAt));
    run.step(action, result);
    rows.push({
      scenario,
      result,
      predicted: result.decision,
      correct: result.decision === scenario.expected,
    });
  }

  const metrics = computeMetrics(
    rows.map((r) => ({ expected: r.scenario.expected, predicted: r.predicted })),
  );

  const byCategory = new Map<string, Metrics>();
  for (const cat of ['safe', 'dangerous', 'ambiguous', 'cumulative']) {
    const subset = rows.filter((r) => r.scenario.category === cat);
    if (subset.length > 0) {
      byCategory.set(
        cat,
        computeMetrics(subset.map((r) => ({ expected: r.scenario.expected, predicted: r.predicted }))),
      );
    }
  }

  printMetrics(metrics, byCategory);
  printFailures(rows, Number(opt('show-failures') ?? 15));

  const sorted = [...latencies].sort((a, b) => a - b);
  const latency = {
    meanMs: sorted.reduce((n, v) => n + v, 0) / (sorted.length || 1),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
  console.log(
    `\nLatency  mean ${latency.meanMs.toFixed(1)}ms  p50 ${latency.p50Ms}ms  p95 ${latency.p95Ms}ms  max ${latency.maxMs}ms`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    engine: kind,
    scenarioCount: selected.length,
    metrics,
    byCategory: Object.fromEntries(byCategory),
    latency,
    results: rows.map((r) => ({
      id: r.scenario.id,
      category: r.scenario.category,
      description: r.scenario.description,
      toolName: r.scenario.toolName,
      expected: r.scenario.expected,
      predicted: r.predicted,
      correct: r.correct,
      riskScore: r.result.riskScore,
      violatedPolicy: r.result.violatedPolicy,
      reasoning: r.result.reasoning,
      latencyMs: r.result.latencyMs,
    })),
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), REPORT_PATH)}`);

  run.end({
    accuracy: metrics.accuracy,
    macroF1: metrics.macroF1,
    weightedF1: metrics.weightedF1,
    mismatches: metrics.total - metrics.correct,
  });
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
