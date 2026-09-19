import type { Decision, EvalResult } from '@agentgate/shared-types';
import {
  captureError,
  instrumentGate,
  observeRun,
  type DecisionPath,
  type EvaluateLike,
} from '@agentgate/observability';
import { materialise, type Scenario } from './scenarios.js';
import { JudgeInvalidOutput, JudgeUnavailable } from './models/errors.js';

/**
 * scored  — the judge returned a conforming decision; counts towards metrics.
 * invalid — output did not conform to the requested schema (a plumbing failure).
 * skipped — the request never resolved after retries (rate limit / timeout).
 * errored — anything else the evaluator threw.
 *
 * Only `scored` rows reach the metrics. Bucketing a schema or quota failure as a
 * wrong decision would make a provider look worse than it actually judged.
 */
export type RowStatus = 'scored' | 'invalid' | 'skipped' | 'errored';

export type Row = {
  scenario: Scenario;
  result: EvalResult;
  predicted: Decision;
  correct: boolean;
  status: RowStatus;
  error?: string;
};

export type Latency = { meanMs: number; p50Ms: number; p95Ms: number; maxMs: number };

export type SuiteCounts = Record<RowStatus, number>;

export type SuiteResult = {
  label: string;
  provider?: string;
  modelId?: string;
  rows: Row[];
  latency: Latency;
  counts: SuiteCounts;
  retries: number;
};

/** Rows that actually produced a decision. Everything downstream uses this. */
export function scoredRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === 'scored');
}

function summariseLatency(values: number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    meanMs: sorted.reduce((n, v) => n + v, 0) / (sorted.length || 1),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Runs every scenario through one evaluate() implementation.
 *
 * The whole suite is one observed run: a Sentry root span with a child span per
 * evaluation, a LangFuse trace, and a correctness score per scenario.
 */
export async function scoreSuite(params: {
  label: string;
  evaluate: EvaluateLike;
  scenarios: Scenario[];
  path?: DecisionPath;
  provider?: string;
  modelId?: string;
  retries?: () => number;
  metadata?: Record<string, unknown>;
}): Promise<SuiteResult> {
  const evaluate = instrumentGate(params.evaluate, params.path ?? 'rule');
  const rows: Row[] = [];
  const latencies: number[] = [];

  await observeRun(
    {
      sessionId: `evalsuite_${params.label}_${Date.now()}`,
      agentId: 'eval-harness',
      name: 'agentgate.eval.suite',
      path: params.path ?? 'rule',
      metadata: { model: params.label, scenarioCount: params.scenarios.length, ...params.metadata },
    },
    async (run) => {
      for (const scenario of params.scenarios) {
        const { action, context } = materialise(scenario);
        const startedAt = performance.now();
        let result: EvalResult;
        let status: RowStatus = 'scored';
        let error: string | undefined;

        try {
          result = await evaluate(action, context);
        } catch (err) {
          // A failing evaluator is a data point, not a crash -- bucket it and
          // keep going, but keep it out of the decision metrics.
          status =
            err instanceof JudgeInvalidOutput
              ? 'invalid'
              : err instanceof JudgeUnavailable
                ? 'skipped'
                : 'errored';
          error = (err as Error).message;
          if (status === 'errored') {
            captureError(err, { scenarioId: scenario.id, toolName: scenario.toolName });
          }
          result = {
            riskScore: -1,
            decision: 'allow',
            reasoning: `${status}: ${error}`,
            latencyMs: Math.round(performance.now() - startedAt),
          };
        }

        if (status === 'scored') {
          latencies.push(result.latencyMs ?? Math.round(performance.now() - startedAt));
        }
        const correct = status === 'scored' && result.decision === scenario.expected;

        // Scoring the trace is what makes it self-evaluating in LangFuse.
        // Unscored rows carry no correctness signal, so they get no score.
        run.step(
          action,
          result,
          undefined,
          status === 'scored'
            ? { scenarioId: scenario.id, expected: scenario.expected, correct }
            : undefined,
        );

        rows.push({ scenario, result, predicted: result.decision, correct, status, error });
      }

      run.end({
        scored: scoredRows(rows).length,
        correct: rows.filter((r) => r.correct).length,
        invalid: rows.filter((r) => r.status === 'invalid').length,
        skipped: rows.filter((r) => r.status === 'skipped').length,
      });
    },
  );

  const counts: SuiteCounts = { scored: 0, invalid: 0, skipped: 0, errored: 0 };
  for (const r of rows) counts[r.status]++;

  return {
    label: params.label,
    provider: params.provider,
    modelId: params.modelId,
    rows,
    latency: summariseLatency(latencies),
    counts,
    retries: params.retries?.() ?? 0,
  };
}
