import type { ActionCategory, AgentAction, Decision, Policy, SessionContext } from '@agentgate/shared';

/** A policy as it lives in the knowledge base, with its retrieval score attached. */
export interface RetrievedPolicy extends Policy {
  /** Full markdown body used to ground the judge. */
  text: string;
  severity: string;
  appliesTo: ActionCategory[];
  score: number;
}

export interface JudgeVerdict {
  riskScore: number;
  reasoning: string;
  violatedPolicy?: string;
}

/** The object that flows through the LangGraph. */
export interface GraphState {
  action: AgentAction;
  context: SessionContext;
  category: ActionCategory;
  categoryConfidence: number;
  policies: RetrievedPolicy[];
  verdict: JudgeVerdict;
  decision: Decision;
  /** Notes appended by the pattern detector when it overrides. */
  patternNotes: string[];
  startedAt: number;
}
