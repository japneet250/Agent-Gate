export interface AgentAction {
  id: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, any>;
  timestamp: Date;
  sessionId: string;
}

export interface EvalResult {
  riskScore: number;
  decision: 'allow' | 'block' | 'escalate';
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
