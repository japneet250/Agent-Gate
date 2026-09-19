import type { Decision } from '@agentgate/shared';
import { config } from '../config.ts';
import { enforceConsistency, fingerprint } from '../guardrails.ts';
import { sessionStore, type SessionState } from '../store/index.ts';
import type { GraphState, GuardrailEvent } from '../state.ts';

const AMOUNT_KEYS = ['amount', 'total', 'price', 'value', 'cost', 'sum'];
const MONEY_TOOLS = /(pay|purchase|order|refund|transfer|charge|payout|invoice)/i;
const PERMISSION_TOOLS = /(grant|permission|role|scope|admin|sudo|iam|privilege)/i;

/** Pull a currency amount out of arbitrary tool args. */
export function extractAmount(args: Record<string, any>): number {
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!AMOUNT_KEYS.some((key) => k.toLowerCase().includes(key))) continue;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Runs after the Decision Gate. Catches what no single-action check can see:
 * cumulative spend, approval-threshold splitting, probing loops, privilege creep.
 * It can only make a decision stricter, never looser.
 */
export async function patternDetectorNode(state: GraphState): Promise<Partial<GraphState>> {
  const sessionId = state.context.sessionId ?? state.action.sessionId;
  const store = sessionStore();
  const session = await store.get(sessionId);
  const fp = fingerprint(state.action.toolName, state.action.toolArgs);

  // Consistency guardrail needs the prior scores before we append this one.
  const consistency = enforceConsistency(state.verdict, session, fp);
  let verdict = consistency.verdict;
  const guardrails: GuardrailEvent[] = [...state.guardrails, ...consistency.guardrails];
  for (const g of consistency.guardrails) state.trace.event(`guardrail.${g.rule}`, g);

  let decision: Decision =
    consistency.guardrails.length > 0 && state.decision === 'allow' && verdict.riskScore >= config.allowBelow
      ? 'escalate'
      : state.decision;

  // Count spend only for actions we would actually have let through.
  const spend = state.category === 'financial' ? extractAmount(state.action.toolArgs) : 0;
  recordAction(session, state.action.toolName, fp, decision === 'allow' ? spend : 0);
  session.recentActions.push({
    toolName: state.action.toolName,
    toolArgs: state.action.toolArgs ?? {},
    at: Date.now(),
  });
  if (session.recentActions.length > 10) session.recentActions.shift();
  if (state.category === 'data_access') session.dataAccessCount++;
  if (PERMISSION_TOOLS.test(state.action.toolName)) session.permissionRequests++;
  session.scoreHistory.push({ fingerprint: fp, riskScore: verdict.riskScore });
  if (session.scoreHistory.length > 100) session.scoreHistory.shift();

  const notes: string[] = [];
  const escalate = (note: string, floor: number, policy?: string) => {
    notes.push(note);
    verdict = {
      ...verdict,
      riskScore: Math.max(verdict.riskScore, floor),
      violatedPolicy: verdict.violatedPolicy ?? policy,
    };
    if (decision === 'allow') decision = 'escalate';
  };

  if (session.totalSpend > config.sessionSpendLimit) {
    const txns = Object.entries(session.actionCounts)
      .filter(([tool]) => MONEY_TOOLS.test(tool))
      .reduce((n, [, c]) => n + c, 0);
    escalate(
      `Cumulative spend alert: $${session.totalSpend.toLocaleString()} across ${txns} transactions this session exceeds the $${config.sessionSpendLimit.toLocaleString()} limit. Pattern: approval-threshold splitting.`,
      75,
      'Cumulative Spending Limit',
    );
  }

  const repeats = session.lastActions.filter(
    (a) => Date.now() - a.at < 60_000 && a.argsKey === fp,
  ).length;
  if (repeats > config.repeatedCallLimit) {
    escalate(
      `Repetition alert: ${repeats} near-identical calls to ${state.action.toolName} in the last minute — possible loop or prompt injection.`,
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

  if (session.permissionRequests >= config.permissionRequestLimit) {
    escalate(
      `Privilege escalation alert: ${session.permissionRequests} permission-related calls this session.`,
      70,
      'Privilege Escalation',
    );
  }

  await store.save(session);
  for (const n of notes) state.trace.event('pattern.alert', { note: n });

  return { patternNotes: notes, decision, verdict, guardrails };
}

function recordAction(session: SessionState, toolName: string, fp: string, spend: number): void {
  session.totalSpend += spend;
  session.actionCounts[toolName] = (session.actionCounts[toolName] ?? 0) + 1;
  session.lastActions.push({ toolName, argsKey: fp, at: Date.now() });
  if (session.lastActions.length > 100) session.lastActions.shift();
}
