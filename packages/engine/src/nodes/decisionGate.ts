import type { Decision } from '@agentgate/shared';
import { config } from '../config.ts';
import type { GraphState } from '../state.ts';

/** Pure threshold logic — no LLM, no I/O. */
export function scoreToDecision(riskScore: number): Decision {
  if (riskScore < config.allowBelow) return 'allow';
  if (riskScore >= config.blockAtOrAbove) return 'block';
  return 'escalate';
}

export function decisionGateNode(state: GraphState): Partial<GraphState> {
  return { decision: scoreToDecision(state.verdict.riskScore) };
}
