"""The public surface. `evaluate` is what the gateway calls."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agentgate_shared import AgentAction, EvalResult, SessionContext

from .config import config
from .graph import get_graph
from .guardrails import check_latency_budget
from .policy_store import is_indexed, load_policies, warm_policy_index
from .state import GuardrailEvent, JudgeVerdict, SessionFacts
from .stores import session_store
from .zip_client import zip_context, zip_configured
from .trace import start_trace


@dataclass
class EvalDetail:
    """Everything the dashboard wants but the gateway contract does not carry."""

    result: EvalResult
    category: str
    retrieved_policies: list[dict[str, Any]] = field(default_factory=list)
    pattern_notes: list[str] = field(default_factory=list)
    guardrails: list[GuardrailEvent] = field(default_factory=list)
    # Real procurement state consulted for this decision, when Zip is wired.
    zip_facts: list[str] | None = None
    # True when a node fell back instead of using its model — trust the score less.
    degraded: bool = False

    def to_wire(self) -> dict[str, Any]:
        """The JSON the HTTP service returns."""
        payload = self.result.model_dump(by_alias=True)
        payload.update(
            {
                "category": self.category,
                "retrievedPolicies": self.retrieved_policies,
                "patternNotes": self.pattern_notes,
                "guardrails": [g.__dict__ for g in self.guardrails],
                "degraded": self.degraded,
                "zipFacts": self.zip_facts,
            }
        )
        return payload


async def evaluate_detailed(
    action: AgentAction, context: SessionContext | None = None
) -> EvalDetail:
    """Run the full pipeline.

    Never raises. Any internal failure — no API key, provider down, timeout,
    malformed model output — degrades to a returned result, never an exception.
    """
    started_at = time.perf_counter()
    session_id = (context.session_id if context else None) or action.session_id

    trace = start_trace(
        "agentgate.evaluate",
        {"agent": action.agent_id, "tool": action.tool_name, "args": action.tool_args},
        session_id,
    )

    def elapsed_ms() -> int:
        return round((time.perf_counter() - started_at) * 1000)

    try:
        session = await session_store().get(session_id)
        from .nodes.pattern_detector import cumulative_policies

        session_facts = SessionFacts(
            actions_this_session=sum(session.action_counts.values()),
            counters={
                p.name: p.limit.format_total(session.counters.get(p.id, 0.0))
                for p in cumulative_policies()
                if p.limit is not None and session.counters.get(p.id)
            },
        )

        # The gateway may pass session history itself. When it does not, fall back
        # to what we recorded, so the judge's reasoning agrees with the pattern
        # detector instead of calling the thirteenth transaction the first.
        recent = context.recent_actions if context else None
        if not recent:
            recent = [
                AgentAction(
                    id=f"{session_id}-history-{i}",
                    agentId=action.agent_id,
                    toolName=a["tool_name"],
                    toolArgs=a["tool_args"],
                    sessionId=session_id,
                )
                for i, a in enumerate(session.recent_actions)
            ]

        resolved_context = SessionContext(
            sessionId=session_id,
            agentId=(context.agent_id if context else None) or action.agent_id,
            recentActions=recent,
        )

        # Ground financial actions in Zip's real state before judging. Only for
        # money-moving tools: a customer lookup has no budget to consult, and
        # the round trip is not free.
        zip_facts: list[str] | None = None
        if zip_configured():
            ctx = await zip_context(action.tool_args or {})
            if ctx is not None:
                from .zip_client import extract_amount as _amt

                lines = ctx.as_prompt_lines(_amt(action.tool_args or {}))
                zip_facts = lines or None

        state = await get_graph().ainvoke(
            {
                "action": action,
                "context": resolved_context,
                "session_facts": session_facts,
                "zip_facts": zip_facts,
                "category": "other",
                "category_confidence": 0.0,
                "policies": [],
                "verdict": JudgeVerdict(),
                "decision": "escalate",
                "pattern_notes": [],
                "guardrails": [],
                "degraded": False,
                "started_at": started_at,
                "trace": trace,
            }
        )

        guardrails = list(state["guardrails"]) + check_latency_budget(elapsed_ms())
        verdict: JudgeVerdict = state["verdict"]
        reasoning = " ".join(
            part for part in [verdict.reasoning, *state["pattern_notes"]] if part
        )

        detail = EvalDetail(
            result=EvalResult(
                riskScore=round(verdict.risk_score),
                decision=state["decision"],
                reasoning=reasoning,
                violatedPolicy=verdict.violated_policy,
                latencyMs=elapsed_ms(),
            ),
            category=state["category"],
            zip_facts=zip_facts,
            retrieved_policies=[
                {"name": p.name, "score": round(p.score, 3)} for p in state["policies"]
            ],
            pattern_notes=list(state["pattern_notes"]),
            guardrails=guardrails,
            degraded=bool(state["degraded"]),
        )
        trace.end(detail.to_wire())
        return detail

    except Exception as err:  # noqa: BLE001
        # The gateway must always get an answer. Unknown risk goes to a human.
        print(f"[agentgate] evaluation failed, escalating: {err}")
        detail = EvalDetail(
            result=EvalResult(
                riskScore=50,
                decision="escalate",
                reasoning=f"AgentGate evaluation failed ({err}); escalating for human review.",
                latencyMs=elapsed_ms(),
            ),
            category="other",
            guardrails=[GuardrailEvent(rule="pipeline_failure", detail=str(err))],
            degraded=True,
        )
        trace.end(detail.to_wire())
        return detail


async def evaluate(
    action: AgentAction, context: SessionContext | None = None
) -> EvalResult:
    """The contract function. Person 1 calls this (directly, or over HTTP)."""
    return (await evaluate_detailed(action, context)).result


async def warmup() -> bool:
    """Call once at boot. Embeds the policy index so the hot path costs one query
    embedding instead of twenty. Returns False if it degraded to keyword-only."""
    load_policies()
    await warm_policy_index()
    return is_indexed()


async def reset_sessions() -> None:
    await session_store().reset()
