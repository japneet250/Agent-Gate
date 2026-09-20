import type { Decision } from '@agentgate/shared-types';
import { computeMetrics, DECISIONS, type Metrics } from './metrics.js';
import { scoredRows, type Row, type SuiteResult } from './score.js';

export const pad = (s: string, n: number) => s.padEnd(n);
export const padL = (s: string, n: number) => s.padStart(n);
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export const CATEGORIES = ['safe', 'dangerous', 'ambiguous', 'cumulative'] as const;

/** Metrics are computed over scored rows only -- see RowStatus in score.ts. */
export function metricsFor(rows: Row[]): Metrics {
  return computeMetrics(
    scoredRows(rows).map((r) => ({ expected: r.scenario.expected, predicted: r.predicted })),
  );
}

export function byCategory(rows: Row[]): Map<string, Metrics> {
  const out = new Map<string, Metrics>();
  for (const cat of CATEGORIES) {
    const subset = scoredRows(rows).filter((r) => r.scenario.category === cat);
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

/**
 * Prints the bucket counts. An invalid or skipped scenario is a plumbing or
 * quota failure, so it must be visible rather than folded into the metrics.
 */
export function printBuckets(suite: SuiteResult): void {
  const { counts } = suite;
  const unscored = counts.invalid + counts.skipped + counts.errored;
  console.log(
    `\nScored ${counts.scored}/${suite.rows.length}` +
      (unscored === 0
        ? ' (all scenarios produced a decision)'
        : ` — ${counts.invalid} invalid (schema), ${counts.skipped} skipped (rate limit / timeout), ${counts.errored} errored`),
  );
  if (suite.retries > 0) console.log(`  ${suite.retries} request(s) retried`);

  if (unscored > 0) {
    const examples = suite.rows.filter((r) => r.status !== 'scored').slice(0, 5);
    for (const r of examples) {
      console.log(`  ${pad(r.status, 9)} ${pad(r.scenario.id, 16)} ${r.error ?? ''}`);
    }
    console.log(
      '  these are NOT counted as wrong decisions — they never produced a decision',
    );
  }
}

export function printFailures(rows: Row[], limit: number) {
  const failures = scoredRows(rows).filter((r) => !r.correct);
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
  /** 'openai' | 'gemini' | undefined when it is the rule engine or the stub. */
  provider?: string;
  /** The exact model id that ran, e.g. "gemini-2.5-flash". Never a family name. */
  modelId?: string;
  engine: string;
  /**
   * TRUE ONLY for --model=engine.
   *
   * The stub and the P3 judge wrapper are eval-engineering artifacts: they do
   * not measure the product. Only P2's engine does, so only that run's number
   * may be quoted as AgentGate's score.
   */
  isProductNumber: boolean;
  scenarioCount: number;
  scenarioHash: string;
  /** How many scenarios actually produced a decision, and why the rest did not. */
  counts: SuiteResult['counts'];
  retries: number;
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
    status: string;
    error?: string;
    riskScore: number;
    violatedPolicy?: string;
    reasoning: string;
    latencyMs: number;
  }>;
};

/** The one condition under which a number may be called AgentGate's score. */
export function isProductNumber(modelName: string): boolean {
  return modelName === 'engine';
}

export function buildReport(params: {
  suite: SuiteResult;
  engine: string;
  modelName: string;
  scenarioHash: string;
}): SuiteReport {
  const { suite } = params;
  const metrics = metricsFor(suite.rows);
  return {
    generatedAt: new Date().toISOString(),
    model: suite.label,
    provider: suite.provider,
    modelId: suite.modelId,
    engine: params.engine,
    isProductNumber: isProductNumber(params.modelName),
    scenarioCount: suite.rows.length,
    scenarioHash: params.scenarioHash,
    counts: suite.counts,
    retries: suite.retries,
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
      status: r.status,
      error: r.error,
      riskScore: r.result.riskScore,
      violatedPolicy: r.result.violatedPolicy,
      reasoning: r.result.reasoning,
      latencyMs: r.result.latencyMs,
    })),
  };
}
