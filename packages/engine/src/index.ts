import type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared';
import { getGraph } from './graph.ts';
import { startTrace, flushTraces } from './trace.ts';
import { warmPolicyIndex, loadPolicies } from './policyStore.ts';
import { getSession, resetSessions } from './session.ts';

/**
 * The single entry point the gateway calls. Rules run in the gateway first;
 * this is the slow path for anything the rule engine didn't decide.
 */
export async function evaluate(
  action: AgentAction,
  context: SessionContext = { sessionId: action.sessionId },
): Promise<EvalResult> {
  const startedAt = Date.now();
  const trace = startTrace('agentgate.evaluate', {
    tool: action.toolName,
    args: action.toolArgs,
  }, context.sessionId);

  const state = await getGraph().invoke({
    action,
    context: { ...context, sessionId: context.sessionId ?? action.sessionId },
    startedAt,
    trace,
  });

  const reasoning = [state.verdict.reasoning, ...(state.patternNotes ?? [])]
    .filter(Boolean)
    .join(' ');

  const result: EvalResult = {
    riskScore: Math.round(state.verdict.riskScore),
    decision: state.decision,
    reasoning,
    violatedPolicy: state.verdict.violatedPolicy,
    latencyMs: Date.now() - startedAt,
  };

  trace.end(result);
  return result;
}

/** Call once at gateway boot: embeds the policy index so the hot path is one query embedding. */
export async function warmup(): Promise<void> {
  await warmPolicyIndex();
}

export { flushTraces, loadPolicies, getSession, resetSessions };
export type { AgentAction, EvalResult, SessionContext };
