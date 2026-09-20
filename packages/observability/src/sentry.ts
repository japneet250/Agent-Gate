import * as Sentry from '@sentry/node';
import type { AgentAction, EvalResult } from '@agentgate/shared-types';

let enabled = false;

/** Which side of the engine produced a decision. Attached to spans and logs. */
export type DecisionPath = 'rule' | 'judge';

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
    // Every evaluation is traced -- at hackathon volume there is nothing to sample away.
    tracesSampleRate: 1.0,
    // Structured Logs. Top-level in SDK v10 (it was `_experiments.enableLogs` before).
    enableLogs: true,
    // AGENTGATE_DEBUG_SENTRY=1 turns on the SDK's own logging.
    debug: !!process.env.AGENTGATE_DEBUG_SENTRY,
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

/**
 * Wraps one evaluate() call in a Sentry span, so a run shows up in Tracing as a
 * tree of decisions rather than only as breadcrumbs on an error.
 *
 * The span carries the decision attributes even when evaluate() throws, so a
 * failed evaluation is still visible with the tool that caused it.
 */
export async function withEvaluationSpan(
  action: AgentAction,
  path: DecisionPath,
  fn: () => Promise<EvalResult>,
): Promise<EvalResult> {
  if (!enabled) return fn();

  return Sentry.startSpan(
    {
      name: `evaluate ${action.toolName}`,
      op: 'agentgate.evaluate',
      attributes: {
        'agentgate.tool_name': action.toolName,
        'agentgate.agent_id': action.agentId,
        'agentgate.session_id': action.sessionId,
        'agentgate.action_id': action.id,
        'agentgate.path': path,
      },
    },
    async (span) => {
      try {
        const result = await fn();
        span.setAttributes({
          'agentgate.decision': result.decision,
          'agentgate.risk_score': result.riskScore,
          'agentgate.violated_policy': result.violatedPolicy ?? 'none',
          'agentgate.latency_ms': result.latencyMs,
        });
        span.setStatus({ code: 1 }); // ok
        return result;
      } catch (err) {
        span.setStatus({ code: 2, message: (err as Error).message }); // error
        throw err;
      }
    },
  );
}

/** Wraps a whole agent run / eval suite as the root of the trace. */
export async function withRunSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  return Sentry.startSpan({ name, op: 'agentgate.run', attributes }, () => fn());
}

/**
 * Structured Logs. Blocks and escalations are the interesting decisions, so they
 * get a searchable log line with the reason -- not just a breadcrumb that is only
 * visible if something else later errors.
 */
export function logDecision(
  action: AgentAction,
  result: EvalResult,
  path: DecisionPath,
): void {
  if (!enabled) return;
  if (result.decision === 'allow') return;

  const attrs = {
    tool_name: action.toolName,
    agent_id: action.agentId,
    session_id: action.sessionId,
    action_id: action.id,
    decision: result.decision,
    risk_score: result.riskScore,
    violated_policy: result.violatedPolicy ?? 'none',
    latency_ms: result.latencyMs,
    path,
  };

  const line = Sentry.logger.fmt`AgentGate ${result.decision} ${action.toolName}: ${result.reasoning}`;
  if (result.decision === 'block') Sentry.logger.error(line, attrs);
  else Sentry.logger.warn(line, attrs);
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
