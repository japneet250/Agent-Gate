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
import { loadScenarios } from './scenarios.js';
import { scoreSuite, type SuiteResult } from './score.js';
import {
  buildReport,
  byCategory,
  isProductNumber,
  metricsFor,
  printBuckets,
  printFailures,
  printMetrics,
} from './report.js';
import { buildByModelReport, printComparison } from './compare.js';
import { parseModelNames, resolveModel, type ModelName } from './models/registry.js';
import { engineDegradedCount } from './engine/index.js';
import { buildRunDoc, historyEnabled, recordRun } from './history.js';
import {
  checkRegression,
  DEFAULT_THRESHOLDS,
  loadBaseline,
  printRegression,
  type Thresholds,
} from './regression.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(here, '..', 'report.json');
const BY_MODEL_PATH = path.join(here, '..', 'report.by-model.json');
const FAILED_REPORT_PATH = path.join(here, '..', 'report.failed.json');

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const numOpt = (n: string, fallback: number) => {
  const raw = opt(n);
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function usage(): never {
  console.error(
    [
      'Usage: npm run eval -w @agentgate/evals -- [options]',
      '',
      '  --model=<list>        stub | engine | openai | gemini (comma-separated for a comparison)',
      '                        default: stub',
      '  --category=<name>     safe | dangerous | ambiguous | cumulative',
      '  --show-failures=N     how many mismatches to print (default 15)',
      '  --strict              exit non-zero if the regression check fails',
      '  --min-macro-f1=N      macro-F1 floor (default 0.8)',
      '  --min-class-recall=N  per-class recall floor (default 0.7)',
      '  --max-delta=N         largest tolerated drop vs the previous run (default 0.05)',
      '  --no-baseline         ignore the previous report.json',
      '  --update-baseline     accept this run as the new baseline even if it failed',
      '  --no-history          skip recording this run to MongoDB',
    ].join('\n'),
  );
  process.exit(1);
}

async function main() {
  if (flag('help')) usage();

  const obs = startObservability('evals');
  const scenarios = loadScenarios();
  const only = opt('category');
  const selected = only ? scenarios.filter((s) => s.category === only) : scenarios;
  if (selected.length === 0) {
    console.error(`No scenarios in category "${only}".`);
    process.exit(1);
  }

  // Identifies the exact scenario set, so a report is never diffed against one
  // that was scored on different inputs.
  const scenarioHash = createHash('sha256')
    .update(JSON.stringify(selected.map((s) => [s.id, s.toolName, s.toolArgs, s.expected])))
    .digest('hex')
    .slice(0, 12);

  const requested = parseModelNames(opt('model'));
  const suites: SuiteResult[] = [];
  const scoredNames: ModelName[] = [];
  const skipped: Array<{ name: ModelName; reason: string }> = [];

  console.log(
    `\nAgentGate eval harness — ${selected.length} scenarios (set ${scenarioHash}), models: ${requested.join(', ')}`,
  );
  console.log(
    `observability: sentry=${obs.sentry ? 'on' : 'off'} langfuse=${obs.langfuse ? 'on' : 'off'} history=${historyEnabled() ? 'on' : 'off'}`,
  );

  for (const name of requested) {
    const outcome = await resolveModel(name);
    if (!outcome.ok) {
      // Same graceful-degradation rule as the observability backends: warn and
      // carry on, so a missing key never blocks the rest of the run.
      console.warn(`\n[skip] ${name}: ${outcome.reason}`);
      skipped.push({ name, reason: outcome.reason });
      continue;
    }

    console.log(`\n--- scoring ${outcome.model.label} ---`);
    suites.push(
      await scoreSuite({
        label: outcome.model.label,
        evaluate: outcome.model.evaluate,
        scenarios: selected,
        path: outcome.model.path,
        provider: outcome.model.provider,
        modelId: outcome.model.modelId,
        retries: outcome.model.retries,
        metadata: { model: outcome.model.label, category: only ?? 'all' },
      }),
    );
    scoredNames.push(name);
  }

  if (suites.length === 0) {
    console.error('\nNo models could be scored.');
    for (const s of skipped) console.error(`  ${s.name}: ${s.reason}`);
    await shutdownObservability();
    process.exit(1);
  }

  // The first successfully scored model is the primary one: it owns report.json
  // and it is what the regression check runs against.
  const primary = suites[0]!;
  const primaryName = scoredNames[0]!;
  const metrics = metricsFor(primary.rows);

  printBuckets(primary);
  printMetrics(metrics, byCategory(primary.rows));
  printFailures(primary.rows, Number(opt('show-failures') ?? 15));

  const { latency } = primary;
  console.log(
    `\nLatency  mean ${latency.meanMs.toFixed(1)}ms  p50 ${latency.p50Ms}ms  p95 ${latency.p95Ms}ms  max ${latency.maxMs}ms`,
  );

  if (suites.length > 1) {
    printComparison(suites);
    const byModel = buildByModelReport({ suites, scenarioHash });
    writeFileSync(BY_MODEL_PATH, `${JSON.stringify(byModel, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(process.cwd(), BY_MODEL_PATH)}`);
  }

  const thresholds: Thresholds = {
    minMacroF1: numOpt('min-macro-f1', DEFAULT_THRESHOLDS.minMacroF1),
    minClassRecall: numOpt('min-class-recall', DEFAULT_THRESHOLDS.minClassRecall),
    maxDelta: numOpt('max-delta', DEFAULT_THRESHOLDS.maxDelta),
  };

  // Read the baseline BEFORE overwriting report.json with this run.
  const baseline = flag('no-baseline') ? undefined : loadBaseline(REPORT_PATH);
  const regression = checkRegression({
    rows: primary.rows,
    metrics,
    baseline,
    scenarioHash,
    thresholds,
  });

  const report = buildReport({
    suite: primary,
    engine: primary.label,
    modelName: primaryName,
    scenarioHash,
  });

  // A failing run must not become the next run's baseline, or one bad commit
  // silently resets the bar. Keep report.json as the last good run and park the
  // failing one beside it.
  const failing = regression.violations.length > 0;
  const keepBaseline = failing && !flag('update-baseline');
  const outPath = keepBaseline ? FAILED_REPORT_PATH : REPORT_PATH;
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}`);

  printRegression(regression, thresholds);

  // Task 3 guard: only --model=engine measures the product.
  if (!isProductNumber(primaryName)) {
    console.log(
      [
        '',
        '  ' + '!'.repeat(64),
        '  !! NOT A PRODUCT NUMBER',
        `  !! This run scored "${primary.modelId ?? primary.label}", not AgentGate.`,
        '  !! The stub and the P3 judge wrapper are eval-engineering artifacts.',
        '  !! Only --model=engine measures the product. Do not quote this on stage.',
        '  ' + '!'.repeat(64),
      ].join('\n'),
    );
  } else {
    // "degraded" means an engine node fell back instead of using its model --
    // no API key, provider down, circuit breaker open. Those evaluations
    // measure the fallback path, not the engine, so a run containing any of
    // them is not clean enough to quote.
    const degraded = engineDegradedCount();
    if (degraded > 0) {
      console.log(
        [
          '',
          '  ' + '!'.repeat(64),
          '  !! DEGRADED RUN — NOT QUOTABLE',
          `  !! ${degraded} of ${primary.rows.length} evaluations came back degraded:true,`,
          '  !! meaning an engine node fell back instead of using its model.',
          '  !! Fix the cause and re-run before quoting this number.',
          '  ' + '!'.repeat(64),
        ].join('\n'),
      );
    } else {
      console.log('\n  This IS the product number (--model=engine), no degraded evaluations.');
    }
  }

  if (keepBaseline && baseline) {
    console.log(
      `\n  baseline report.json left untouched — rerun with --update-baseline to accept these numbers`,
    );
  }

  // Eval-run history (P3's own runs only -- action logs live in P1's D1 store).
  if (!flag('no-history')) {
    const id = await recordRun(
      buildRunDoc({
        model: primary.label,
        metrics,
        latency: primary.latency,
        scenarioHash,
        scenarioCount: primary.rows.length,
        category: only ?? 'all',
        reportPath: path.relative(process.cwd(), outPath),
        passed: !failing,
      }),
    );
    if (id) console.log(`\n  recorded eval run ${id} to MongoDB`);
  }

  await shutdownObservability();

  if (regression.violations.length > 0 && flag('strict')) process.exit(1);
}

main().catch(async (err) => {
  captureError(err, { service: 'evals' });
  console.error(err);
  await shutdownObservability();
  process.exit(1);
});
