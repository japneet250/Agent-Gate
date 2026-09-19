import type { AgentAction, EvalResult } from '@agentgate/shared-types';
import {
  breadcrumbEvaluation,
  captureBlockedAction,
  captureError,
  flushSentry,
  initSentry,
  sentryEnabled,
} from './sentry.js';
import {
  flushLangfuse,
  initLangfuse,
  langfuseEnabled,
  startRunTrace,
  type RunTrace,
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
  /** Report one gated tool call: evaluation plus whatever the tool returned. */
  step: (action: AgentAction, result: EvalResult, output?: string) => void;
  end: (output?: Record<string, unknown>) => void;
};

export function observeRun(params: {
  sessionId: string;
  agentId: string;
  name?: string;
  metadata?: Record<string, unknown>;
}): RunObserver {
  const trace: RunTrace = startRunTrace(params);

  return {
    step(action, result, output) {
      breadcrumbEvaluation(action, result);
      if (result.decision === 'block') captureBlockedAction(action, result);

      const span = trace.toolCall(action);
      span.evaluated(result);
      if (result.decision === 'allow') span.executed(output);
      span.end();
    },
    end(output) {
      trace.update(output ?? {});
    },
  };
}

export async function shutdownObservability(): Promise<void> {
  await Promise.all([flushSentry(), flushLangfuse()]);
}

export { captureError, sentryEnabled, langfuseEnabled };
