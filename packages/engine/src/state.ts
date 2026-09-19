import type { ActionCategory, AgentAction, Decision, Policy, SessionContext } from '@agentgate/shared';
import type { Trace } from './trace.ts';

/** A policy from the knowledge base, with its retrieval scores attached. */
export interface RetrievedPolicy extends Policy {
  /** Full markdown body, used to ground the judge. */
  text: string;
  severity: string;
  appliesTo: ActionCategory[];
  /**
   * Which layer enforces this policy. Cumulative policies belong to the pattern
   * detector, which holds exact counts; showing them to the judge would invite it
   * to guess at a threshold it cannot see, which made its decisions nondeterministic.
   */
  enforcedBy: 'judge' | 'pattern_detector';
  /** Blended hybrid score. */
  score: number;
  denseScore: number;
  sparseScore: number;
}

export interface JudgeVerdict {
  riskScore: number;
  reasoning: string;
  violatedPolicy?: string;
}

/** A guardrail that fired on this evaluation. Surfaced for the dashboard. */
export interface GuardrailEvent {
  rule: string;
  detail: string;
}

/** Deterministic session totals, so the judge reasons with numbers not guesses. */
export interface SessionFacts {
  actionsThisSession: number;
  totalSpend: number;
  dataAccessCount: number;
  permissionRequests: number;
  spendLimit: number;
}

/** The object that flows through the LangGraph. */
export interface GraphState {
  action: AgentAction;
  context: SessionContext;
  sessionFacts: SessionFacts;
  category: ActionCategory;
  categoryConfidence: number;
  policies: RetrievedPolicy[];
  verdict: JudgeVerdict;
  decision: Decision;
  /** Notes appended by the pattern detector when it overrides a decision. */
  patternNotes: string[];
  guardrails: GuardrailEvent[];
  /** True when any node fell back instead of using its model. */
  degraded: boolean;
  startedAt: number;
  trace: Trace;
}
