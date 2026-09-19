"""The object that flows through the LangGraph, plus its value types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict

from agentgate_shared import ActionCategory, AgentAction, Decision, SessionContext


@dataclass
class RetrievedPolicy:
    """A policy from the knowledge base with its retrieval scores attached."""

    id: str
    name: str
    description: str
    text: str
    severity: str
    applies_to: list[str]
    # Which layer enforces this policy. Cumulative policies belong to the pattern
    # detector, which holds exact counts; showing them to the judge invites it to
    # guess at a threshold it cannot see, which makes its decisions nondeterministic.
    enforced_by: str = "judge"
    enabled: bool = True
    score: float = 0.0
    dense_score: float = 0.0
    sparse_score: float = 0.0


@dataclass
class JudgeVerdict:
    risk_score: float = 50.0
    reasoning: str = ""
    violated_policy: str | None = None


@dataclass
class GuardrailEvent:
    """A guardrail that fired on this evaluation. Surfaced for the dashboard."""

    rule: str
    detail: str


@dataclass
class SessionFacts:
    """Deterministic session totals, so the judge reasons with numbers not guesses."""

    actions_this_session: int = 0
    total_spend: float = 0.0
    data_access_count: int = 0
    permission_requests: int = 0
    spend_limit: float = 0.0


class GraphState(TypedDict, total=False):
    action: AgentAction
    context: SessionContext
    session_facts: SessionFacts
    category: ActionCategory
    category_confidence: float
    policies: list[RetrievedPolicy]
    verdict: JudgeVerdict
    decision: Decision
    # Notes appended by the pattern detector when it overrides a decision.
    pattern_notes: list[str]
    guardrails: list[GuardrailEvent]
    # True when a node fell back instead of using its model.
    degraded: bool
    started_at: float
    trace: Any
