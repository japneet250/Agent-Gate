"""Node 4 — pure threshold logic. No LLM, no I/O."""

from __future__ import annotations

from typing import Any

from ..config import config
from ..state import GraphState


def score_to_decision(risk_score: float) -> str:
    if risk_score < config.allow_below:
        return "allow"
    if risk_score >= config.block_at:
        return "block"
    return "escalate"


def decision_gate_node(state: GraphState) -> dict[str, Any]:
    return {"decision": score_to_decision(state["verdict"].risk_score)}
