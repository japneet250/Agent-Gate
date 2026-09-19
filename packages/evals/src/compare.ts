import { DECISIONS, type Metrics } from './metrics.js';
import { metricsFor, pad, padL, pct } from './report.js';
import { scoredRows, type SuiteResult } from './score.js';
import { tierOf } from './models/registry.js';

export type ModelSummary = {
  model: string;
  /** EXACT model id. A summary may never be labelled with a family name. */
  modelId?: string;
  provider?: string;
  tier?: 'small' | 'large';
  counts: SuiteResult['counts'];
  retries: number;
  metrics: Metrics;
  latency: SuiteResult['latency'];
};

export type ByModelReport = {
  generatedAt: string;
  /** The only label that may be used for this comparison, built from exact ids. */
  comparisonLabel: string;
  /** True when the compared models are not the same size tier. */
  tierMismatch: boolean;
  isProductNumber: false;
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
 * Builds the ONLY label this comparison may be described with.
 *
 * It is made from the exact model ids that actually ran, so a run of
 * gpt-4o-mini against gemini-2.5-flash can never be written up as
 * "GPT-4o vs Gemini". Anything that wants a headline takes it from here.
 */
export function comparisonLabel(suites: SuiteResult[]): string {
  return suites.map((s) => s.modelId ?? s.label).join(' vs ');
}

export function hasTierMismatch(suites: SuiteResult[]): boolean {
  const tiers = new Set(suites.filter((s) => s.modelId).map((s) => tierOf(s.modelId!)));
  return tiers.size > 1;
}

/**
 * The disagreement list is the headline.
 *
 * A raw "X% vs Y%" invites a fairness argument we cannot fully win — different
 * providers, different tiers, different schema subsets. Where the two models
 * disagreed and which one matched our label is the defensible artifact, so it
 * goes first and the aggregate goes after it.
 */
export function printComparison(suites: SuiteResult[]): void {
  const label = comparisonLabel(suites);
  const mismatch = hasTierMismatch(suites);

  console.log(`\n=== Model comparison: ${label} ===`);
  for (const s of suites) {
    const tier = s.modelId ? ` (${tierOf(s.modelId)} tier)` : '';
    const unscored = s.counts.invalid + s.counts.skipped + s.counts.errored;
    console.log(
      `  ${pad(s.modelId ?? s.label, 28)}${tier}  scored ${s.counts.scored}/${s.rows.length}` +
        (unscored > 0
          ? `  [${s.counts.invalid} invalid, ${s.counts.skipped} skipped, ${s.counts.errored} errored]`
          : ''),
    );
  }
  if (mismatch) {
    console.log(
      '\n  !! TIER MISMATCH — these models are not the same size class.\n' +
        '     Do not present this as a like-for-like comparison. Either say the exact\n' +
        '     model ids above, or rerun with comparable tiers.',
    );
  }
  console.log(
    `\n  Describe this run ONLY as: "${label}". Not by provider family name.`,
  );

  // --- headline: where they disagreed ---
  const disagreements = findDisagreements(suites);
  const comparable = suites[0] ? scoredRows(suites[0].rows).length : 0;
  console.log(`\n--- Disagreements (the headline): ${disagreements.length} of ${comparable} jointly scored scenarios ---`);

  if (disagreements.length === 0) {
    console.log('  none — the models agreed on every jointly scored scenario');
  }
  for (const d of disagreements.slice(0, 20)) {
    const preds = Object.entries(d.predictions)
      .map(([m, p]) => `${m}=${p}${p === d.expected ? ' ✓' : ' ✗'}`)
      .join('   ');
    console.log(`\n  ${d.id}  [${d.category}]  our label: ${d.expected}`);
    console.log(`    ${d.description}`);
    console.log(`    ${preds}`);
  }
  if (disagreements.length > 20) {
    console.log(`\n  ... ${disagreements.length - 20} more (see report.by-model.json)`);
  }

  // --- secondary: the aggregate ---
  const width = Math.max(22, ...suites.map((s) => (s.modelId ?? s.label).length + 2));
  const metrics = suites.map((s) => metricsFor(s.rows));
  const row = (label2: string, values: string[]) =>
    console.log(`  ${pad(label2, 22)}${values.map((v) => padL(v, width)).join('')}`);

  console.log('\n--- Aggregate (secondary; read the disagreements first) ---');
  console.log(`  ${pad('metric', 22)}${suites.map((s) => padL(s.modelId ?? s.label, width)).join('')}`);
  console.log(`  ${'-'.repeat(22 + width * suites.length)}`);

  row('scenarios scored', suites.map((s) => String(s.counts.scored)));
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
  row('retries', suites.map((s) => String(s.retries)));

  console.log(
    '\n  NOTE: neither of these is AgentGate\'s score. They measure judge models\n' +
      '  through a P3 eval wrapper, not the product. Only --model=engine does that.',
  );
}

export function findDisagreements(suites: SuiteResult[]): ByModelReport['disagreements'] {
  if (suites.length < 2) return [];
  const [first, ...rest] = suites;
  const out: ByModelReport['disagreements'] = [];

  first!.rows.forEach((row, i) => {
    // Only compare scenarios every model actually scored; an invalid or skipped
    // row is not a disagreement, it is a missing answer.
    if (row.status !== 'scored') return;
    if (rest.some((suite) => suite.rows[i]?.status !== 'scored')) return;

    const key = (s: SuiteResult) => s.modelId ?? s.label;
    const predictions: Record<string, string> = { [key(first!)]: row.predicted };
    let differs = false;
    for (const suite of rest) {
      const other = suite.rows[i];
      if (!other) continue;
      predictions[key(suite)] = other.predicted;
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
    comparisonLabel: comparisonLabel(params.suites),
    tierMismatch: hasTierMismatch(params.suites),
    // A judge-wrapper comparison never measures the product.
    isProductNumber: false,
    scenarioCount: params.suites[0]?.rows.length ?? 0,
    scenarioHash: params.scenarioHash,
    models: params.suites.map((s) => ({
      model: s.label,
      modelId: s.modelId,
      provider: s.provider,
      tier: s.modelId ? tierOf(s.modelId) : undefined,
      counts: s.counts,
      retries: s.retries,
      metrics: metricsFor(s.rows),
      latency: s.latency,
    })),
    disagreements: findDisagreements(params.suites),
  };
}
