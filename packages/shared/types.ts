/**
 * The contract between gateway (Person 1), engine (Person 2) and
 * demo-agents/evals (Person 3). Change this file only by agreement.
 */

export interface AgentAction {
  id: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, any>;
  timestamp: Date;
  sessionId: string;
}

export type Decision = 'allow' | 'block' | 'escalate';

export interface EvalResult {
  riskScore: number;
  decision: Decision;
  reasoning: string;
  violatedPolicy?: string;
  latencyMs: number;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  type: 'rule' | 'llm';
  pattern?: string;
  enabled: boolean;
}

/** Action categories produced by the classifier node. */
export type ActionCategory =
  | 'data_access'
  | 'external_comms'
  | 'financial'
  | 'system_modification'
  | 'other';

/** What the gateway hands the engine alongside a single action. */
export interface SessionContext {
  sessionId: string;
  agentId?: string;
  /** Most recent actions in this session, oldest first. */
  recentActions?: AgentAction[];
}
