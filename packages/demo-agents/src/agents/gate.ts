import { randomUUID } from 'node:crypto';
import type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared-types';

/**
 * The interception seam. Every tool call an agent wants to make goes through a
 * ToolGate first; the gate decides allow / block / escalate.
 *
 * TODO: replace `passThroughGate` with the real path once P1's gateway and P2's
 * `evaluate()` land. The agent code above this does not change.
 */
export type ToolGate = (
  action: AgentAction,
  context: SessionContext,
) => Promise<EvalResult>;

export function makeAction(
  agentId: string,
  sessionId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): AgentAction {
  return {
    id: randomUUID(),
    agentId,
    toolName,
    toolArgs,
    timestamp: Date.now(),
    sessionId,
  };
}

/** Default gate: allows everything. Useful for showing the "before AgentGate" demo. */
export const passThroughGate: ToolGate = async () => ({
  riskScore: 0,
  decision: 'allow',
  reasoning: 'no gate configured (pass-through)',
  latencyMs: 0,
});
