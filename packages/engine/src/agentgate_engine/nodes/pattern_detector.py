"""Node 5 — what no single-action check can see.

Runs after the Decision Gate. It can only make a decision stricter, never looser.

Two kinds of control live here, and the distinction matters:

**Policy-defined limits.** Anything a policy declares with `Accumulate:` and
`Limit:`. What gets counted is the enterprise's choice, not this file's — spend
for a bank, patient records for a hospital, exported rows for a SaaS company.
Adding a dimension means writing a markdown file, not changing code.

**Structural controls.** Loop detection is built in and not policy-defined,
because it protects the firewall itself rather than enforcing a business rule:
an agent repeating one identical call is looping or under prompt injection, and
that is true for every customer.
"""

from __future__ import annotations

import time
from typing import Any

from ..config import config
from ..guardrails import enforce_consistency, fingerprint
from ..policy_store import load_policies
from ..state import GraphState, GuardrailEvent, JudgeVerdict, RetrievedPolicy
from ..stores import SessionState, session_store


def cumulative_policies() -> list[RetrievedPolicy]:
    """Every enabled policy that declares a cumulative limit.

    Deliberately NOT restricted to the policies retrieved for this action: a
    spend limit must see every payment in the session, not only the ones whose
    text happened to rank in the top five.
    """
    return [p for p in load_policies() if p.enabled and p.limit is not None]


def _counts_this_action(policy: RetrievedPolicy, state: GraphState) -> bool:
    limit = policy.limit
    assert limit is not None
    if policy.applies_to and state["category"] not in policy.applies_to:
        return False
    return limit.applies_to_tool(state["action"].tool_name)


def extract_amount(args: dict[str, Any] | None) -> float:
    """Kept for callers and tests; money is now just one accumulator form."""
    from ..limits import LimitSpec

    return LimitSpec(accumulate="sum(toolArgs.amount)", limit=1).measure(args)


def _record_action(session: SessionState, tool_name: str, fp: str) -> None:
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

    _record_action(session, action.tool_name, fp)
    session.recent_actions.append(
        {"tool_name": action.tool_name, "tool_args": action.tool_args or {}, "at": time.time()}
    )
    if len(session.recent_actions) > 10:
        session.recent_actions.pop(0)

    session.score_history.append({"fingerprint": fp, "risk_score": verdict.risk_score})
    if len(session.score_history) > 100:
        session.score_history.pop(0)

    notes: list[str] = []

    def tighten(note: str, floor: float, policy_name: str, to: str) -> None:
        nonlocal verdict, decision
        notes.append(note)
        verdict = JudgeVerdict(
            risk_score=max(verdict.risk_score, floor),
            reasoning=verdict.reasoning,
            violated_policy=verdict.violated_policy or policy_name,
        )
        # Only ever stricter: allow -> escalate -> block.
        rank = {"allow": 0, "escalate": 1, "block": 2}
        if rank[to] > rank[decision]:
            decision = to

    # ---- policy-defined limits -------------------------------------------
    for policy in cumulative_policies():
        limit = policy.limit
        assert limit is not None
        if not _counts_this_action(policy, state):
            continue

        # Count only what we would actually have let through, so a blocked
        # payment does not inflate the running total toward a false alarm.
        contribution = limit.measure(action.tool_args) if decision == "allow" else 0.0
        if contribution:
            session.counters[policy.id] = session.counters.get(policy.id, 0.0) + contribution

        total = session.counters.get(policy.id, 0.0)
        if total > limit.limit:
            occurrences = sum(
                c for tool, c in session.action_counts.items() if limit.applies_to_tool(tool)
            )
            tighten(
                f"{policy.name}: {limit.format_total(total)} across {occurrences} actions this "
                f"session exceeds the limit of {limit.format_total(limit.limit)}."
                + (
                    " Pattern: approval-threshold splitting."
                    if limit.sum_field
                    else " Pattern: cumulative volume."
                ),
                limit.risk_floor,
                policy.name,
                limit.when_exceeded,
            )

    # ---- structural control: loop / injection detection -------------------
    now = time.time()
    repeats = sum(1 for a in session.last_actions if now - a["at"] < 60 and a["fingerprint"] == fp)
    if repeats > config.repeated_call_limit:
        tighten(
            f"Repetition alert: {repeats} near-identical calls to {action.tool_name} in the last "
            "minute — possible loop or prompt injection.",
            60,
            "Action Rate Limits",
            "escalate",
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
