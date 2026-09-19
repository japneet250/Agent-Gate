import { DECISIONS, type Metrics } from './metrics.js';
import { metricsFor, pad, padL, pct } from './report.js';
import type { SuiteResult } from './score.js';

export type ModelSummary = {
  model: string;
  metrics: Metrics;
  latency: SuiteResult['latency'];
};

export type ByModelReport = {
  generatedAt: string;
  scenarioCount: number;
  scenarioHash: string;
  models: ModelSummary[];
  /** Scenarios where the models disagreed with each other. */
  disagreements: Array<{
    id: string;
    category: string;
    description: string;
    expected: string;
    predictions: Record<string, string>;
  }>;
};

/**
 * Side-by-side table. With two models this is the headline comparison; with
 * more it still reads, one column per model.
 */
export function printComparison(suites: SuiteResult[]): void {
  const width = Math.max(22, ...suites.map((s) => s.label.length + 2));

  const header = `  ${pad('metric', 22)}${suites.map((s) => padL(s.label, width)).join('')}`;
  console.log('\n=== Model comparison ===');
  console.log(header);
  console.log(`  ${'-'.repeat(22 + width * suites.length)}`);

  const metrics = suites.map((s) => metricsFor(s.rows));

  const row = (label: string, values: string[]) =>
    console.log(`  ${pad(label, 22)}${values.map((v) => padL(v, width)).join('')}`);

  row('accuracy', metrics.map((m) => pct(m.accuracy)));
  row('macro-F1', metrics.map((m) => m.macroF1.toFixed(3)));
  row('weighted-F1', metrics.map((m) => m.weightedF1.toFixed(3)));

  for (const d of DECISIONS) {
    console.log(`  ${pad(`${d}:`, 22)}`);
    row('  precision', metrics.map((m) => pct(m.perClass.find((c) => c.decision === d)!.precision)));
    row('  recall', metrics.map((m) => pct(m.perClass.find((c) => c.decision === d)!.recall)));
    row('  f1', metrics.map((m) => m.perClass.find((c) => c.decision === d)!.f1.toFixed(3)));
  }

  row('mean latency', suites.map((s) => `${s.latency.meanMs.toFixed(0)}ms`));
  row('p95 latency', suites.map((s) => `${s.latency.p95Ms.toFixed(0)}ms`));

  // The interesting part of a comparison is where the models disagree.
  const disagreements = findDisagreements(suites);
  console.log(`\nDisagreements: ${disagreements.length} of ${suites[0]?.rows.length ?? 0} scenarios`);
  for (const d of disagreements.slice(0, 12)) {
    const preds = Object.entries(d.predictions)
      .map(([m, p]) => `${m}=${p}${p === d.expected ? '' : ' ✗'}`)
      .join('  ');
    console.log(`  ${pad(d.id, 16)} expected ${pad(d.expected, 9)} ${preds}`);
    console.log(`  ${pad('', 16)} └─ ${d.description}`);
  }
  if (disagreements.length > 12) {
    console.log(`  ... ${disagreements.length - 12} more`);
  }
}

export function findDisagreements(suites: SuiteResult[]): ByModelReport['disagreements'] {
  if (suites.length < 2) return [];
  const [first, ...rest] = suites;
  const out: ByModelReport['disagreements'] = [];

  first!.rows.forEach((row, i) => {
    const predictions: Record<string, string> = { [first!.label]: row.predicted };
    let differs = false;
    for (const suite of rest) {
      const other = suite.rows[i];
      if (!other) continue;
      predictions[suite.label] = other.predicted;
      if (other.predicted !== row.predicted) differs = true;
    }
    if (differs) {
      out.push({
        id: row.scenario.id,
        category: row.scenario.category,
        description: row.scenario.description,
        expected: row.scenario.expected,
        predictions,
      });
    }
  });

  return out;
}

export function buildByModelReport(params: {
  suites: SuiteResult[];
  scenarioHash: string;
}): ByModelReport {
  return {
    generatedAt: new Date().toISOString(),
    scenarioCount: params.suites[0]?.rows.length ?? 0,
    scenarioHash: params.scenarioHash,
    models: params.suites.map((s) => ({
      model: s.label,
      metrics: metricsFor(s.rows),
      latency: s.latency,
    })),
    disagreements: findDisagreements(params.suites),
  };
}
