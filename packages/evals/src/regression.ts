import { existsSync, readFileSync } from 'node:fs';
import type { Decision } from '@agentgate/shared-types';
import { DECISIONS, type Metrics } from './metrics.js';
import { pad, padL, pct, type SuiteReport } from './report.js';
import type { Row } from './score.js';

/**
 * Compares this run against the previous report.json and fails the run when
 * something got worse.
 *
 * This is the safety net for the whole team: P2 tunes a prompt, the suite
 * re-runs, and anything that regressed is named. It has to be impossible to
 * miss in a terminal, hence the banner.
 */
export type Thresholds = {
  /** Absolute floor for macro-F1. */
  minMacroF1: number;
  /** Absolute floor for every class's recall. */
  minClassRecall: number;
  /** Largest tolerated drop vs the previous run, for any tracked metric. */
  maxDelta: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  minMacroF1: 0.8,
  minClassRecall: 0.7,
  maxDelta: 0.05,
};

export type Violation = { kind: 'floor' | 'regression'; metric: string; detail: string };

export type RegressionResult = {
  baseline?: { generatedAt: string; model: string; scenarioHash: string };
  comparable: boolean;
  violations: Violation[];
  flipped: Array<{
    id: string;
    description: string;
    expected: Decision;
    was: Decision;
    now: Decision;
    direction: 'fixed' | 'broken' | 'changed';
  }>;
  deltas: Array<{ metric: string; before: number; after: number; delta: number }>;
};

export function loadBaseline(path: string): SuiteReport | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SuiteReport;
  } catch {
    return undefined;
  }
}

function trackedMetrics(m: Metrics): Record<string, number> {
  const out: Record<string, number> = {
    'macro-F1': m.macroF1,
    accuracy: m.accuracy,
  };
  for (const c of m.perClass) {
    out[`${c.decision} recall`] = c.recall;
    out[`${c.decision} precision`] = c.precision;
  }
  return out;
}

export function checkRegression(params: {
  rows: Row[];
  metrics: Metrics;
  baseline?: SuiteReport;
  scenarioHash: string;
  thresholds: Thresholds;
}): RegressionResult {
  const { metrics, baseline, thresholds } = params;
  const violations: Violation[] = [];

  // Absolute floors apply whether or not there is anything to compare against.
  if (metrics.macroF1 < thresholds.minMacroF1) {
    violations.push({
      kind: 'floor',
      metric: 'macro-F1',
      detail: `${metrics.macroF1.toFixed(3)} < floor ${thresholds.minMacroF1}`,
    });
  }
  for (const c of metrics.perClass) {
    if (c.support > 0 && c.recall < thresholds.minClassRecall) {
      violations.push({
        kind: 'floor',
        metric: `${c.decision} recall`,
        detail: `${pct(c.recall)} < floor ${pct(thresholds.minClassRecall)}`,
      });
    }
  }

  // A baseline scored on a different scenario set is not a fair comparison.
  const comparable = Boolean(baseline) && baseline!.scenarioHash === params.scenarioHash;

  const deltas: RegressionResult['deltas'] = [];
  const flipped: RegressionResult['flipped'] = [];

  if (comparable && baseline) {
    const before = trackedMetrics(baseline.metrics);
    const after = trackedMetrics(metrics);

    for (const [metric, afterValue] of Object.entries(after)) {
      const beforeValue = before[metric];
      if (beforeValue === undefined) continue;
      const delta = afterValue - beforeValue;
      deltas.push({ metric, before: beforeValue, after: afterValue, delta });
      if (delta < -thresholds.maxDelta) {
        violations.push({
          kind: 'regression',
          metric,
          detail: `${beforeValue.toFixed(3)} -> ${afterValue.toFixed(3)} (${delta.toFixed(3)}, max drop ${thresholds.maxDelta})`,
        });
      }
    }

    const previous = new Map(baseline.results.map((r) => [r.id, r]));
    for (const row of params.rows) {
      const was = previous.get(row.scenario.id);
      if (!was || was.predicted === row.predicted) continue;
      const wasCorrect = was.predicted === row.scenario.expected;
      flipped.push({
        id: row.scenario.id,
        description: row.scenario.description,
        expected: row.scenario.expected,
        was: was.predicted,
        now: row.predicted,
        direction: row.correct && !wasCorrect ? 'fixed' : !row.correct && wasCorrect ? 'broken' : 'changed',
      });
    }
  }

  return {
    baseline: baseline
      ? {
          generatedAt: baseline.generatedAt,
          model: baseline.model,
          scenarioHash: baseline.scenarioHash,
        }
      : undefined,
    comparable,
    violations,
    flipped,
    deltas,
  };
}

const arrow = (d: number) => (d > 0.0005 ? '▲' : d < -0.0005 ? '▼' : '=');

export function printRegression(result: RegressionResult, thresholds: Thresholds): void {
  console.log('\n=== Regression check ===');

  if (!result.baseline) {
    console.log('  no previous report.json — floors only, nothing to diff against');
  } else if (!result.comparable) {
    console.log(
      `  previous report.json used a different scenario set (${result.baseline.scenarioHash} vs current) — floors only`,
    );
  } else {
    console.log(
      `  vs ${result.baseline.model} @ ${result.baseline.generatedAt}  (max tolerated drop ${thresholds.maxDelta})`,
    );
    console.log(`  ${pad('metric', 20)}${padL('before', 10)}${padL('after', 10)}${padL('delta', 11)}`);
    for (const d of result.deltas) {
      console.log(
        `  ${pad(d.metric, 20)}${padL(d.before.toFixed(3), 10)}${padL(d.after.toFixed(3), 10)}${padL(`${arrow(d.delta)} ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(3)}`, 11)}`,
      );
    }

    const broken = result.flipped.filter((f) => f.direction === 'broken');
    const fixed = result.flipped.filter((f) => f.direction === 'fixed');
    console.log(`\n  scenarios flipped: ${result.flipped.length} (${fixed.length} fixed, ${broken.length} broken)`);
    for (const f of [...broken, ...fixed].slice(0, 12)) {
      const tag = f.direction === 'broken' ? 'BROKEN' : 'fixed ';
      console.log(
        `    ${tag} ${pad(f.id, 16)} ${f.was} -> ${f.now}  (expected ${f.expected})  ${f.description}`,
      );
    }
  }

  const failed = result.violations.length > 0;
  const banner = failed ? 'REGRESSION CHECK FAILED' : 'REGRESSION CHECK PASSED';
  const bar = '='.repeat(banner.length + 4);
  console.log(`\n  ${bar}\n  = ${banner} =\n  ${bar}`);

  for (const v of result.violations) {
    console.log(`    ${v.kind === 'floor' ? 'FLOOR' : 'DROP '}  ${pad(v.metric, 20)} ${v.detail}`);
  }
}

export { DECISIONS };
