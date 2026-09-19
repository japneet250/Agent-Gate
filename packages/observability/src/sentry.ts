import * as Sentry from '@sentry/node';
import type { AgentAction, EvalResult } from '@agentgate/shared-types';

let enabled = false;

export type SentryOptions = {
  /** Shows up as the Sentry `service` tag, e.g. "demo-agents" or "evals". */
  service: string;
  dsn?: string;
  environment?: string;
};

/**
 * Initialises Sentry for a P3 process. Safe to call when SENTRY_DSN is unset --
 * it simply no-ops so the demo and the harness still run offline.
 */
export function initSentry(options: SentryOptions): boolean {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn(`[sentry] SENTRY_DSN not set -- error tracking disabled for ${options.service}`);
    return false;
  }

  Sentry.init({
    dsn,
    environment: options.environment ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 1.0,
    // Every evaluation is a breadcrumb, so a session can be a long trail.
    maxBreadcrumbs: 200,
    initialScope: { tags: { service: options.service, component: 'agentgate' } },
  });

  enabled = true;
  return true;
}

export const sentryEnabled = (): boolean => enabled;

/**
 * One breadcrumb per evaluation. This is the trail that shows up underneath an
 * error in Sentry: exactly which tool calls the agent tried and what AgentGate
 * decided about each, right up to the moment things broke.
 */
export function breadcrumbEvaluation(action: AgentAction, result: EvalResult): void {
  if (!enabled) return;
  Sentry.addBreadcrumb({
    type: 'default',
    category: 'agentgate.evaluate',
    message: `${result.decision.toUpperCase()} ${action.toolName} (risk ${result.riskScore})`,
    level:
      result.decision === 'block' ? 'error' : result.decision === 'escalate' ? 'warning' : 'info',
    data: {
      actionId: action.id,
      agentId: action.agentId,
      sessionId: action.sessionId,
      toolName: action.toolName,
      toolArgs: action.toolArgs,
      decision: result.decision,
      riskScore: result.riskScore,
      violatedPolicy: result.violatedPolicy ?? null,
      reasoning: result.reasoning,
      latencyMs: result.latencyMs,
    },
    timestamp: action.timestamp / 1000,
  });
}

/** A blocked dangerous action is the product working -- but we still want to see it. */
export function captureBlockedAction(action: AgentAction, result: EvalResult): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setTag('decision', result.decision);
    scope.setTag('toolName', action.toolName);
    scope.setTag('violatedPolicy', result.violatedPolicy ?? 'none');
    scope.setContext('agentgate', {
      action: action as unknown as Record<string, unknown>,
      evaluation: result as unknown as Record<string, unknown>,
    });
    Sentry.captureMessage(
      `AgentGate blocked ${action.toolName}: ${result.violatedPolicy ?? 'policy'}`,
    );
  });
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) {
    console.error('[sentry disabled]', err);
    return;
  }
  Sentry.withScope((scope) => {
    if (context) scope.setContext('agentgate', context);
    Sentry.captureException(err);
  });
}

/** Sentry batches over the network -- short-lived CLI processes must flush. */
export async function flushSentry(timeoutMs = 3000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => {});
}

export { Sentry };
