"""Node 5 — what no single-action check can see.

Runs after the Decision Gate: cumulative spend, approval-threshold splitting,
probing loops, privilege creep. It can only make a decision stricter, never looser.
"""

from __future__ import annotations

import re
import time
from typing import Any

from ..config import config
from ..guardrails import enforce_consistency, fingerprint
from ..state import GraphState, GuardrailEvent, JudgeVerdict
from ..stores import SessionState, session_store

_AMOUNT_KEYS = ("amount", "total", "price", "value", "cost", "sum")
_MONEY_TOOLS = re.compile(r"(pay|purchase|order|refund|transfer|charge|payout|invoice)", re.I)
_PERMISSION_TOOLS = re.compile(r"(grant|permission|role|scope|admin|sudo|iam|privilege)", re.I)


def extract_amount(args: dict[str, Any] | None) -> float:
    """Pull a currency amount out of arbitrary tool args."""
    for key, value in (args or {}).items():
        if not any(k in key.lower() for k in _AMOUNT_KEYS):
            continue
        try:
            number = float(value) if isinstance(value, (int, float)) else float(
                re.sub(r"[^0-9.\-]", "", str(value))
            )
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return 0.0


def _record_action(session: SessionState, tool_name: str, fp: str, spend: float) -> None:
    session.total_spend += spend
    session.action_counts[tool_name] = session.action_counts.get(tool_name, 0) + 1
    session.last_actions.append({"tool_name": tool_name, "fingerprint": fp, "at": time.time()})
    if len(session.last_actions) > 100:
        session.last_actions.pop(0)


async def pattern_detector_node(state: GraphState) -> dict[str, Any]:
    action = state["action"]
    session_id = state["context"].session_id or action.session_id
    store = session_store()
    session = await store.get(session_id)
    fp = fingerprint(action.tool_name, action.tool_args)

    # The consistency guardrail needs prior scores before we append this one.
    verdict, consistency_events = enforce_consistency(state["verdict"], session, fp)
    guardrails: list[GuardrailEvent] = state["guardrails"] + consistency_events
    for g in consistency_events:
        state["trace"].event(f"guardrail.{g.rule}", g.__dict__)

    decision = state["decision"]
    if consistency_events and decision == "allow" and verdict.risk_score >= config.allow_below:
        decision = "escalate"

    # Count spend only for actions we would actually have let through.
    spend = extract_amount(action.tool_args) if state["category"] == "financial" else 0.0
    _record_action(session, action.tool_name, fp, spend if decision == "allow" else 0.0)

    session.recent_actions.append(
        {"tool_name": action.tool_name, "tool_args": action.tool_args or {}, "at": time.time()}
    )
    if len(session.recent_actions) > 10:
        session.recent_actions.pop(0)

    if state["category"] == "data_access":
        session.data_access_count += 1
    if _PERMISSION_TOOLS.search(action.tool_name):
        session.permission_requests += 1

    session.score_history.append({"fingerprint": fp, "risk_score": verdict.risk_score})
    if len(session.score_history) > 100:
        session.score_history.pop(0)

    notes: list[str] = []

    def escalate(note: str, floor: float, policy: str | None = None) -> None:
        nonlocal verdict, decision
        notes.append(note)
        verdict = JudgeVerdict(
            risk_score=max(verdict.risk_score, floor),
            reasoning=verdict.reasoning,
            violated_policy=verdict.violated_policy or policy,
        )
        if decision == "allow":
            decision = "escalate"

    if session.total_spend > config.session_spend_limit:
        txns = sum(c for tool, c in session.action_counts.items() if _MONEY_TOOLS.search(tool))
        escalate(
            f"Cumulative spend alert: ${session.total_spend:,.0f} across {txns} transactions this "
            f"session exceeds the ${config.session_spend_limit:,.0f} limit. "
            "Pattern: approval-threshold splitting.",
            75,
            "Cumulative Spending Limit",
        )

    now = time.time()
    repeats = sum(
        1 for a in session.last_actions if now - a["at"] < 60 and a["fingerprint"] == fp
    )
    if repeats > config.repeated_call_limit:
        escalate(
            f"Repetition alert: {repeats} near-identical calls to {action.tool_name} in the last "
            "minute — possible loop or prompt injection.",
            60,
            "Action Rate Limits",
        )

    if session.data_access_count > config.data_access_limit:
        escalate(
            f"Data access alert: {session.data_access_count} data reads this session — "
            "possible bulk exfiltration.",
            60,
            "Bulk Data Export",
        )

    if session.permission_requests >= config.permission_request_limit:
        escalate(
            f"Privilege escalation alert: {session.permission_requests} permission-related calls "
            "this session.",
            70,
            "Privilege Escalation",
        )

    await store.save(session)
    for note in notes:
        state["trace"].event("pattern.alert", {"note": note})

    return {
        "pattern_notes": notes,
        "decision": decision,
        "verdict": verdict,
        "guardrails": guardrails,
    }
