import type { Decision } from '@agentgate/shared-types';
import { computeMetrics, DECISIONS, type Metrics } from './metrics.js';
import type { Row, SuiteResult } from './score.js';

export const pad = (s: string, n: number) => s.padEnd(n);
export const padL = (s: string, n: number) => s.padStart(n);
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export const CATEGORIES = ['safe', 'dangerous', 'ambiguous', 'cumulative'] as const;

export function metricsFor(rows: Row[]): Metrics {
  return computeMetrics(rows.map((r) => ({ expected: r.scenario.expected, predicted: r.predicted })));
}

export function byCategory(rows: Row[]): Map<string, Metrics> {
  const out = new Map<string, Metrics>();
  for (const cat of CATEGORIES) {
    const subset = rows.filter((r) => r.scenario.category === cat);
    if (subset.length > 0) out.set(cat, metricsFor(subset));
  }
  return out;
}

export function printMetrics(metrics: Metrics, categories: Map<string, Metrics>) {
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
  for (const [cat, m] of categories) {
    const predicted = DECISIONS.map((d) =>
      padL(String(DECISIONS.reduce((n, e) => n + m.confusion[e][d], 0)), 11),
    ).join('');
    console.log(
      `  ${pad(cat, 12)}${padL(String(m.total), 5)}${padL(pct(m.accuracy), 11)}   ${predicted}`,
    );
  }
}

export function printFailures(rows: Row[], limit: number) {
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

export type SuiteReport = {
  generatedAt: string;
  model: string;
  engine: string;
  scenarioCount: number;
  scenarioHash: string;
  metrics: Metrics;
  byCategory: Record<string, Metrics>;
  latency: SuiteResult['latency'];
  results: Array<{
    id: string;
    category: string;
    description: string;
    toolName: string;
    expected: Decision;
    predicted: Decision;
    correct: boolean;
    riskScore: number;
    violatedPolicy?: string;
    reasoning: string;
    latencyMs: number;
  }>;
};

export function buildReport(params: {
  suite: SuiteResult;
  engine: string;
  scenarioHash: string;
}): SuiteReport {
  const { suite } = params;
  const metrics = metricsFor(suite.rows);
  return {
    generatedAt: new Date().toISOString(),
    model: suite.label,
    engine: params.engine,
    scenarioCount: suite.rows.length,
    scenarioHash: params.scenarioHash,
    metrics,
    byCategory: Object.fromEntries(byCategory(suite.rows)),
    latency: suite.latency,
    results: suite.rows.map((r) => ({
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
}
