"""The evaluator needs evaluation too.

These run on the Risk Judge's own output before it is allowed to influence a
decision. All four guardrails from the project spec live here.
"""

from __future__ import annotations

import json
from typing import Any

from .config import config
from .policy_store import policy_exists
from .state import GuardrailEvent, JudgeVerdict, RetrievedPolicy
from .stores import SessionState


def _canonical(value: Any) -> str:
    """Key order must not change an action's identity."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def fingerprint(tool_name: str, args: dict[str, Any] | None) -> str:
    """Identity of a specific action — tool name plus argument VALUES.

    Deliberately value-based, not shape-based. Thirty purchase orders to thirty
    different vendors are thirty distinct actions, not a loop; and a benign email
    and one carrying an SSN must be allowed to score differently. Keying on the
    shape of the arguments collapses both cases and makes the loop detector and
    the consistency guardrail fire on ordinary work.
    """
    return f"{tool_name}:{_canonical(args or {})}"


def validate_judge_output(
    raw: Any, policies: list[RetrievedPolicy]
) -> tuple[JudgeVerdict, list[GuardrailEvent]]:
    """Guardrails 1 and 2.

    1. Structured output conformance — score must be a number in 0-100 and the
       reasoning must be non-empty.
    2. No hallucinated policy references — a cited policy must exist in the store
       AND have been among the ones retrieved for this action.
    """
    guardrails: list[GuardrailEvent] = []
    obj: dict[str, Any] = raw if isinstance(raw, dict) else {}

    try:
        risk_score = float(obj.get("risk_score"))  # type: ignore[arg-type]
        if risk_score != risk_score:  # NaN
            raise ValueError("NaN")
    except (TypeError, ValueError):
        guardrails.append(
            GuardrailEvent(
                rule="structured_output",
                detail=f"risk_score was not a number ({obj.get('risk_score')!r}); defaulted to 50.",
            )
        )
        risk_score = 50.0
    else:
        if risk_score < 0 or risk_score > 100:
            guardrails.append(
                GuardrailEvent(
                    rule="structured_output",
                    detail=f"risk_score {risk_score} out of range; clamped to 0-100.",
                )
            )
            risk_score = max(0.0, min(100.0, risk_score))

    reasoning = str(obj.get("reasoning") or "").strip()
    if not reasoning:
        guardrails.append(
            GuardrailEvent(rule="structured_output", detail="Judge returned empty reasoning.")
        )
        reasoning = "Judge returned no reasoning."

    cited = str(obj.get("violated_policy") or "").strip()
    violated_policy: str | None = None
    if cited:
        retrieved = next((p for p in policies if p.name.lower() == cited.lower()), None)
        if retrieved is not None:
            violated_policy = retrieved.name
        elif policy_exists(cited):
            guardrails.append(
                GuardrailEvent(
                    rule="policy_grounding",
                    detail=(
                        f'Judge cited "{cited}", which exists but was not retrieved for this '
                        "action; citation dropped."
                    ),
                )
            )
        else:
            guardrails.append(
                GuardrailEvent(
                    rule="policy_grounding",
                    detail=(
                        f'Judge cited "{cited}", which is not in the policy store; citation '
                        "dropped (hallucination)."
                    ),
                )
            )

    return (
        JudgeVerdict(risk_score=risk_score, reasoning=reasoning, violated_policy=violated_policy),
        guardrails,
    )


def enforce_consistency(
    verdict: JudgeVerdict, session: SessionState, fp: str
) -> tuple[JudgeVerdict, list[GuardrailEvent]]:
    """Guardrail 3 — the identical action twice in one session should not get
    wildly different scores.

    On drift we take the stricter score, so an inconsistent judge can never be
    the reason something dangerous gets through.
    """
    prior = [h["risk_score"] for h in session.score_history if h["fingerprint"] == fp]
    if not prior:
        return verdict, []

    prior_max = max(prior)
    drift = abs(prior_max - verdict.risk_score)
    if drift <= config.consistency_drift_limit:
        return verdict, []

    stricter = max(prior_max, verdict.risk_score)
    return (
        JudgeVerdict(
            risk_score=stricter,
            reasoning=verdict.reasoning,
            violated_policy=verdict.violated_policy,
        ),
        [
            GuardrailEvent(
                rule="consistency",
                detail=(
                    f"Same action scored {verdict.risk_score:g} now vs {prior_max:g} earlier this "
                    f"session (drift {drift:g}); took the stricter score {stricter:g}."
                ),
            )
        ],
    )


def check_latency_budget(elapsed_ms: float) -> list[GuardrailEvent]:
    """Guardrail 4 — flag an evaluation that blew its budget, so the gateway can
    decide whether to trust it or fall back to rules only."""
    if elapsed_ms <= config.latency_budget_ms:
        return []
    return [
        GuardrailEvent(
            rule="latency_budget",
            detail=f"Evaluation took {elapsed_ms:.0f}ms, over the {config.latency_budget_ms:.0f}ms budget.",
        )
    ]
