import { config } from '../config.ts';
import { extractAmount, getSession, recordAction } from '../session.ts';
import type { GraphState } from '../state.ts';

/**
 * Runs after the Decision Gate. Catches what no single-action check can see:
 * cumulative spend, approval-threshold splitting, probing loops, privilege creep.
 * Can only make a decision stricter, never looser.
 */
export function patternDetectorNode(state: GraphState): Partial<GraphState> {
  const session = getSession(state.context.sessionId ?? state.action.sessionId);
  const spend = state.category === 'financial' ? extractAmount(state.action.toolArgs) : 0;

  // Only count spend we would actually have let through.
  recordAction(session, state.action, state.decision === 'allow' ? spend : 0);
  if (state.category === 'data_access') session.dataAccessCount++;
  if (/(grant|permission|role|scope|admin|sudo)/i.test(state.action.toolName)) {
    session.permissionRequests++;
  }

  const notes: string[] = [];
  let riskScore = state.verdict.riskScore;
  let decision = state.decision;
  let violatedPolicy = state.verdict.violatedPolicy;

  const escalate = (note: string, floor: number, policy?: string) => {
    notes.push(note);
    riskScore = Math.max(riskScore, floor);
    if (decision === 'allow') decision = 'escalate';
    violatedPolicy ??= policy;
  };

  if (session.totalSpend > config.sessionSpendLimit) {
    const count = Object.entries(session.actionCounts)
      .filter(([tool]) => /(pay|purchase|order|refund|transfer)/i.test(tool))
      .reduce((n, [, c]) => n + c, 0);
    escalate(
      `Cumulative spend alert: $${session.totalSpend.toLocaleString()} across ${count} transactions this session exceeds the $${config.sessionSpendLimit.toLocaleString()} limit. Pattern: approval-threshold splitting.`,
      75,
      'Cumulative Spending Limit',
    );
  }

  const recent = session.lastActions.filter((a) => Date.now() - a.at < 60_000);
  const repeats = recent.filter(
    (a) =>
      a.toolName === state.action.toolName &&
      a.argsKey === JSON.stringify(Object.keys(state.action.toolArgs ?? {}).sort()),
  ).length;
  if (repeats > config.repeatedCallLimit) {
    escalate(
      `Repetition alert: ${repeats} near-identical calls to ${state.action.toolName} in the last minute — possible loop or prompt-injection.`,
      60,
      'Action Rate Limits',
    );
  }

  if (session.dataAccessCount > config.dataAccessLimit) {
    escalate(
      `Data access alert: ${session.dataAccessCount} data reads this session — possible bulk exfiltration.`,
      60,
      'Bulk Data Export',
    );
  }

  if (session.permissionRequests >= 3) {
    escalate(
      `Privilege escalation alert: ${session.permissionRequests} permission-related calls this session.`,
      70,
      'Privilege Escalation',
    );
  }

  if (notes.length === 0) return { patternNotes: [] };

  return {
    patternNotes: notes,
    decision,
    verdict: { ...state.verdict, riskScore, violatedPolicy },
  };
}
