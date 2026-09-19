import type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared';
import { config } from './config.ts';
import { checkLatencyBudget } from './guardrails.ts';
import { getGraph } from './graph.ts';
import { loadPolicies, warmPolicyIndex, isIndexed } from './policyStore.ts';
import { sessionStore } from './store/index.ts';
import { flushTraces, startTrace } from './trace.ts';
import type { GuardrailEvent } from './state.ts';

/** Everything the dashboard wants but the gateway contract doesn't carry. */
export interface EvalDetail extends EvalResult {
  category: string;
  retrievedPolicies: { name: string; score: number }[];
  patternNotes: string[];
  guardrails: GuardrailEvent[];
  /** True when a node fell back instead of using its model — trust the result less. */
  degraded: boolean;
}

/**
 * The single entry point the gateway calls. The gateway's deterministic rules
 * run first; this is the slow path for everything they did not decide.
 *
 * Never throws: any internal failure degrades to `escalate` with a reason.
 */
export async function evaluateDetailed(
  action: AgentAction,
  context: SessionContext = { sessionId: action.sessionId },
): Promise<EvalDetail> {
  const startedAt = Date.now();
  const trace = startTrace(
    'agentgate.evaluate',
    { agent: action.agentId, tool: action.toolName, args: action.toolArgs },
    context.sessionId ?? action.sessionId,
  );

  try {
    const sessionId = context.sessionId ?? action.sessionId;

    // The gateway may pass session history itself. When it does not, fall back to
    // what we recorded, so the judge's reasoning agrees with the pattern detector
    // instead of calling the thirteenth transaction the first.
    const session = await sessionStore().get(sessionId);
    const sessionFacts = {
      actionsThisSession: Object.values(session.actionCounts).reduce((n, c) => n + c, 0),
      totalSpend: session.totalSpend,
      dataAccessCount: session.dataAccessCount,
      permissionRequests: session.permissionRequests,
      spendLimit: config.sessionSpendLimit,
    };

    let recentActions = context.recentActions;
    if (!recentActions?.length) {
      recentActions = session.recentActions.map((a, i) => ({
        id: `${sessionId}-history-${i}`,
        agentId: action.agentId,
        toolName: a.toolName,
        toolArgs: a.toolArgs as Record<string, unknown>,
        timestamp: new Date(a.at),
        sessionId,
      }));
    }

    const state = await getGraph().invoke({
      action,
      context: { ...context, sessionId, recentActions },
      sessionFacts,
      startedAt,
      trace,
    });

    const latencyGuardrails = checkLatencyBudget({ ...state, startedAt } as never);
    const guardrails = [...state.guardrails, ...latencyGuardrails];
    const reasoning = [state.verdict.reasoning, ...state.patternNotes].filter(Boolean).join(' ');

    const result: EvalDetail = {
      riskScore: Math.round(state.verdict.riskScore),
      decision: state.decision,
      reasoning,
      violatedPolicy: state.verdict.violatedPolicy,
      latencyMs: Date.now() - startedAt,
      category: state.category,
      retrievedPolicies: state.policies.map((p) => ({ name: p.name, score: Number(p.score.toFixed(3)) })),
      patternNotes: state.patternNotes,
      guardrails,
      degraded: state.degraded,
    };

    trace.end(result);
    return result;
  } catch (err) {
    // The gateway must always get an answer. Unknown risk goes to a human.
    const message = (err as Error).message;
    console.error('[agentgate] evaluation failed, escalating:', message);
    const result: EvalDetail = {
      riskScore: 50,
      decision: 'escalate',
      reasoning: `AgentGate evaluation failed (${message}); escalating for human review.`,
      latencyMs: Date.now() - startedAt,
      category: 'other',
      retrievedPolicies: [],
      patternNotes: [],
      guardrails: [{ rule: 'pipeline_failure', detail: message }],
      degraded: true,
    };
    trace.end(result);
    return result;
  }
}

/** The contract function. Person 1 calls this. */
export async function evaluate(
  action: AgentAction,
  context?: SessionContext,
): Promise<EvalResult> {
  const { riskScore, decision, reasoning, violatedPolicy, latencyMs } = await evaluateDetailed(
    action,
    context,
  );
  return { riskScore, decision, reasoning, violatedPolicy, latencyMs };
}

/**
 * Call once at gateway boot. Embeds the policy index so the hot path costs one
 * query embedding instead of nineteen. Returns false if it degraded to
 * keyword-only retrieval.
 */
export async function warmup(): Promise<boolean> {
  loadPolicies();
  await warmPolicyIndex();
  return isIndexed();
}

export async function resetSessions(): Promise<void> {
  await sessionStore().reset();
}

export { flushTraces, loadPolicies, isIndexed };
export { configureStores } from './store/index.ts';
export type { SessionState, SessionStore, VectorStore } from './store/index.ts';
export type { GuardrailEvent } from './state.ts';
export type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared';
