import type { AgentAction, EvalResult } from '@agentgate/shared';

// Error tracking hooks. The gateway calls these; a runtime plugs Sentry in behind them (sentry-node.ts for the
// MCP proxy / local server, worker.ts for Cloudflare). With no monitor set, every call is a no-op.
//
// PRIVACY: tool arguments can contain SSNs, cards and so on, and requests carry the gateway key. Nothing here
// ever takes them: breadcrumbs carry the tool name, agent, decision and rule names only, and `scrubEvent`
// strips request data from anything Sentry would send.

export interface Monitor {
  captureException(err: unknown, context?: { tags?: Record<string, string> }): void;
  addBreadcrumb(crumb: { category: string; message: string; data?: Record<string, unknown> }): void;
}

let monitor: Monitor | undefined;
export const setMonitor = (m: Monitor | undefined) => void (monitor = m);

/** Reports an error we handled (fail-closed paths, failed writes, judge outages). `where` becomes a Sentry tag. */
export function reportError(err: unknown, where: string): void {
  try {
    monitor?.captureException(err, { tags: { where } });
  } catch {
    // monitoring must never break a decision
  }
}

/** Leaves a trail so an error report shows the decisions that led up to it (no arguments, see above). */
export function decisionBreadcrumb(action: AgentAction, result: EvalResult): void {
  try {
    monitor?.addBreadcrumb({
      category: 'agentgate.decision',
      message: `${action.toolName} -> ${result.decision}`,
      data: { agent: action.agentId, session: action.sessionId, risk: result.riskScore, policy: result.violatedPolicy ?? null },
    });
  } catch {
    // ignore
  }
}

/**
 * Sentry `beforeSend` hook: drops everything request-shaped (body, headers incl. Authorization, cookies, query string,
 * URL) and the user block, so an error report can't carry tool arguments or the gateway key.
 */
export function scrubEvent<T extends { request?: unknown; user?: unknown }>(event: T): T {
  delete event.request;
  delete event.user;
  return event;
}

/** Drops Sentry's console breadcrumbs: our own log lines would carry argument values when AGENTGATE_LOG_ARGS=1. */
export const withoutConsoleBreadcrumbs = <I extends { name: string }>(defaults: I[]): I[] => defaults.filter((i) => i.name !== 'Console');

export const SENTRY_BASE_OPTIONS = {
  sendDefaultPii: false,
  tracesSampleRate: 0,
  includeLocalVariables: false, // never attach the values of variables in scope (tool arguments) to a stack trace
  serverName: 'agentgate', // don't send the machine's hostname
} as const;
