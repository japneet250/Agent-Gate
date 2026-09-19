import type { Decision, EvalResult } from '@agentgate/shared-types';
import {
  captureError,
  instrumentGate,
  observeRun,
  type DecisionPath,
  type EvaluateLike,
} from '@agentgate/observability';
import { materialise, type Scenario } from './scenarios.js';

export type Row = {
  scenario: Scenario;
  result: EvalResult;
  predicted: Decision;
  correct: boolean;
};

export type Latency = { meanMs: number; p50Ms: number; p95Ms: number; maxMs: number };

export type SuiteResult = { label: string; rows: Row[]; latency: Latency };

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
        const correct = result.decision === scenario.expected;

        // Scoring the trace is what makes it self-evaluating in LangFuse.
        run.step(action, result, undefined, {
          scenarioId: scenario.id,
          expected: scenario.expected,
          correct,
        });

        rows.push({ scenario, result, predicted: result.decision, correct });
      }

      run.end({ scored: rows.length, correct: rows.filter((r) => r.correct).length });
    },
  );

  return { label: params.label, rows, latency: summariseLatency(latencies) };
}
