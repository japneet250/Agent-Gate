/**
 * AgentGate shared contracts.
 *
 * These four types are the team-agreed contract (P1 gateway <-> P2 engine <-> P3 evals).
 * Do not change unilaterally -- raise it in SHARED_CONTEXT.md first.
 */

export type AgentAction = {
  id: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  timestamp: number;
  sessionId: string;
};

export type Decision = 'allow' | 'block' | 'escalate';

export type EvalResult = {
  /** 0-100 */
  riskScore: number;
  decision: Decision;
  reasoning: string;
  violatedPolicy?: string;
  latencyMs: number;
};

export type Policy = {
  id: string;
  name: string;
  description: string;
  type: 'rule' | 'llm';
  pattern?: string;
  enabled: boolean;
};

/**
 * PROVISIONAL -- proposed by P3, owned by P2. Confirm before relying on it.
 * See SHARED_CONTEXT.md > Interfaces & Contracts.
 */
export type SessionContext = {
  sessionId: string;
  recentActions: AgentAction[];
  cumulative: {
    spend: number;
    dataAccessCount: number;
  };
};

/** Decision thresholds used by the P3 stub engine and eval sanity checks. */
export const RISK_THRESHOLDS = {
  /** riskScore < 30 -> allow */
  allow: 30,
  /** 30 <= riskScore < 70 -> escalate */
  escalate: 70,
  /** riskScore >= 70 -> block */
} as const;

export function decisionForRiskScore(riskScore: number): Decision {
  if (riskScore < RISK_THRESHOLDS.allow) return 'allow';
  if (riskScore < RISK_THRESHOLDS.escalate) return 'escalate';
  return 'block';
}
