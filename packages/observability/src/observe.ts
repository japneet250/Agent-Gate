import type {
  AgentAction,
  EvalResult,
  SessionContext,
} from '@agentgate/shared-types';
import {
  breadcrumbEvaluation,
  captureBlockedAction,
  captureError,
  flushSentry,
  initSentry,
  logDecision,
  sentryEnabled,
  withEvaluationSpan,
  withRunSpan,
  type DecisionPath,
} from './sentry.js';
import {
  flushLangfuse,
  initLangfuse,
  langfuseEnabled,
  startRunTrace,
  type RunTrace,
  type ScoreInfo,
} from './langfuse.js';

/**
 * One facade over Sentry + LangFuse so callers wire observability once and then
 * report each gated tool call in a single line. Everything degrades to a no-op
 * when the relevant keys are missing.
 */

export type ObservabilityStatus = { sentry: boolean; langfuse: boolean };

export function startObservability(service: string): ObservabilityStatus {
  const sentry = initSentry({ service });
  const langfuse = initLangfuse() !== undefined;

  // Anything that escapes the process should still reach Sentry with the
  // breadcrumb trail attached, then flush before we die.
  process.on('uncaughtException', (err) => {
    captureError(err, { service, fatal: true });
    void shutdownObservability().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    captureError(reason, { service, fatal: false, kind: 'unhandledRejection' });
  });

  return { sentry, langfuse };
}

export type RunObserver = {
  /**
   * Report one gated tool call: evaluation, whatever the tool returned, and --
   * when the caller knows the ground truth, as the eval harness does -- a
   * correctness score to attach to the trace.
   */
  step: (
    action: AgentAction,
    result: EvalResult,
    output?: string,
    score?: ScoreInfo,
  ) => void;
  end: (output?: Record<string, unknown>) => void;
};

export type EvaluateLike = (
  action: AgentAction,
  context: SessionContext,
) => Promise<EvalResult>;

/**
 * Wraps an evaluate()/gate function so every call it makes is a Sentry span.
 * The wrapper is transparent -- callers keep the same signature.
 */
export function instrumentGate(gate: EvaluateLike, path: DecisionPath = 'rule'): EvaluateLike {
  return (action, context) => withEvaluationSpan(action, path, () => gate(action, context));
}

export type RunParams = {
  sessionId: string;
  agentId: string;
  name?: string;
  /** Which side of the engine is deciding; tags spans and logs. */
  path?: DecisionPath;
  metadata?: Record<string, unknown>;
};

/**
 * Runs `fn` inside a root Sentry span and a LangFuse trace. Everything the
 * callback does -- including instrumented evaluate() calls -- nests underneath.
 */
export async function observeRun<T>(
  params: RunParams,
  fn: (run: RunObserver) => Promise<T>,
): Promise<T> {
  const trace: RunTrace = startRunTrace(params);
  const path: DecisionPath = params.path ?? 'rule';

  const observer: RunObserver = {
    step(action, result, output, score) {
      breadcrumbEvaluation(action, result);
      logDecision(action, result, path);
      if (result.decision === 'block') captureBlockedAction(action, result);

      const span = trace.toolCall(action);
      span.evaluated(result);
      if (result.decision === 'allow') span.executed(output);
      if (score) span.scored(score);
      span.end();
    },
    end(output) {
      trace.update(output ?? {});
    },
  };

  return withRunSpan(
    params.name ?? 'agentgate.agent.run',
    {
      'agentgate.session_id': params.sessionId,
      'agentgate.agent_id': params.agentId,
      'agentgate.path': path,
    },
    () => fn(observer),
  );
}

export async function shutdownObservability(): Promise<void> {
  await Promise.all([flushSentry(), flushLangfuse()]);
}

export { captureError, sentryEnabled, langfuseEnabled };
export type { DecisionPath, ScoreInfo };
