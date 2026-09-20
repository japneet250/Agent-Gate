"""Cumulative pattern detection and the consistency guardrail."""

from __future__ import annotations

from agentgate_engine import evaluate_detailed
from agentgate_engine.config import config
from agentgate_engine.guardrails import fingerprint

from .conftest import make_action


def po(n: int, session: str = "procurement"):
    """A $400 purchase order — individually well under the $500 approval threshold."""
    return make_action(
        "approve_payment", {"vendor": f"Vendor {n}", "amount": 400, "poNumber": f"PO-{n}"}, session
    )


class TestFingerprint:
    def test_ignores_key_order_but_not_values(self):
        assert fingerprint("t", {"a": 1, "b": 2}) == fingerprint("t", {"b": 2, "a": 1})
        assert fingerprint("approve_payment", {"vendor": "Acme"}) != fingerprint(
            "approve_payment", {"vendor": "Globex"}
        ), "different vendors are different actions, not a loop"


class TestCumulativeSpend:
    async def test_allows_each_order_until_session_total_crosses_the_limit(self, harness):
        harness()
        results = [await evaluate_detailed(po(i)) for i in range(1, 21)]

        # 12 x $400 = $4,800 is under the limit; the 13th tips it over.
        flagged_at = next(
            i for i, r in enumerate(results) if r.result.decision != "allow"
        )
        assert flagged_at == 12, f"expected the 13th order to flag, got #{flagged_at + 1}"

        assert all(r.result.decision == "allow" for r in results[:12]), (
            "individually-safe orders must pass without friction"
        )

        flagged = results[12]
        assert flagged.result.decision == "escalate"
        assert "Cumulative Spending Limit:" in flagged.result.reasoning
        assert "approval-threshold splitting" in flagged.result.reasoning
        assert flagged.result.violated_policy == "Cumulative Spending Limit"
        assert flagged.result.risk_score >= 75

    async def test_keeps_sessions_isolated(self, harness):
        harness()
        for i in range(1, 21):
            await evaluate_detailed(po(i, "session-a"))
        other = await evaluate_detailed(po(1, "session-b"))
        assert other.result.decision == "allow", (
            "one agent's spend must not taint another session"
        )

    async def test_does_not_count_spend_it_did_not_allow(self, harness):
        harness(judge=lambda prompt: {"risk_score": 95, "reasoning": "blocked", "violated_policy": ""})
        for i in range(1, 21):
            await evaluate_detailed(po(i))
        r = await evaluate_detailed(po(99))
        # Everything was blocked, so nothing was ever counted — no cumulative alert.
        assert "Cumulative Spending Limit:" not in r.result.reasoning


class TestLoopDetection:
    async def test_flags_identical_call_repeated_past_the_limit(self, harness):
        harness()
        fired_at = 0
        for i in range(1, config.repeated_call_limit + 4):
            r = await evaluate_detailed(
                make_action("lookup_customer", {"customerId": "C-1"}, "loop-session")
            )
            if "Repetition alert" in r.result.reasoning and not fired_at:
                fired_at = i
        assert fired_at == config.repeated_call_limit + 1

    async def test_does_not_flag_same_tool_with_different_arguments(self, harness):
        harness()
        for i in range(1, config.repeated_call_limit + 4):
            r = await evaluate_detailed(
                make_action("lookup_customer", {"customerId": f"C-{i}"}, "varied-session")
            )
            assert "Repetition alert" not in r.result.reasoning, f"flagged at #{i}"


class TestPrivilegeEscalation:
    async def test_escalates_after_repeated_permission_calls(self, harness):
        harness()
        flagged = None
        for i in range(1, 4):
            flagged = await evaluate_detailed(
                make_action("grant_role", {"role": f"role-{i}"}, "priv-session")
            )
        assert "Privilege Escalation:" in flagged.result.reasoning
        assert flagged.result.decision != "allow"


class TestConsistencyGuardrail:
    async def test_takes_stricter_score_when_identical_action_scores_inconsistently(self, harness):
        calls = {"n": 0}

        def judge(prompt: str) -> dict:
            calls["n"] += 1
            # Same action, wildly different scores — an inconsistent judge.
            return {
                "risk_score": 80 if calls["n"] == 1 else 5,
                "reasoning": "mock",
                "violated_policy": "",
            }

        harness(judge=judge)
        act = make_action("issue_refund", {"customerId": "C-1", "amount": 300}, "consistency")
        first = await evaluate_detailed(act)
        second = await evaluate_detailed(act)

        assert first.result.risk_score == 80
        assert second.result.risk_score == 80, "the inconsistent low score must not win"
        assert any(g.rule == "consistency" for g in second.guardrails)
        assert second.result.decision != "allow"

    async def test_leaves_genuinely_different_actions_alone(self, harness):
        calls = {"n": 0}

        def judge(prompt: str) -> dict:
            calls["n"] += 1
            return {
                "risk_score": 80 if calls["n"] == 1 else 5,
                "reasoning": "mock",
                "violated_policy": "",
            }

        harness(judge=judge)
        await evaluate_detailed(make_action("send_email", {"body": "SSN 123-45-6789"}, "s"))
        benign = await evaluate_detailed(make_action("send_email", {"body": "your receipt"}, "s"))
        assert benign.result.risk_score == 5, (
            "a different email must not inherit the dangerous score"
        )
        assert benign.result.decision == "allow"


class TestPolicyDefinedLimits:
    """The product claim: an enterprise adds a NEW cumulative dimension by
    writing a policy file, with no change to engine code."""

    HEALTHCARE = (
        "phi-access-volume.md",
        """# PHI Access Volume
An agent reading an unusual number of patient records in one session is a
possible bulk-extraction attempt, even when each individual read is authorised.
Severity: critical
Applies to: data_access
Enforced by: pattern_detector
Accumulate: count()
Scope: session
Limit: 3
When exceeded: escalate
Risk floor: 80
""",
    )

    async def test_a_brand_new_dimension_is_enforced_with_no_code_change(self, harness):
        from agentgate_engine.policy_store import set_policies

        harness()
        # A policy set this engine has never seen: healthcare, counting records,
        # nothing to do with money.
        set_policies([self.HEALTHCARE])

        results = []
        for i in range(1, 6):
            results.append(
                await evaluate_detailed(
                    make_action("lookup_patient", {"mrn": f"MRN-{i}"}, "phi-session")
                )
            )

        assert all(r.result.decision == "allow" for r in results[:3]), (
            "the first three reads are within the declared limit"
        )
        flagged = results[3]
        assert flagged.result.decision == "escalate"
        assert flagged.result.violated_policy == "PHI Access Volume"
        assert flagged.result.risk_score >= 80, "the policy's declared risk floor is honoured"
        assert "exceeds the limit of 3" in flagged.result.reasoning

    async def test_a_limit_only_counts_the_categories_it_declares(self, harness):
        from agentgate_engine.policy_store import set_policies

        harness()
        set_policies([self.HEALTHCARE])

        # Financial actions must not advance a data_access counter.
        for i in range(1, 6):
            r = await evaluate_detailed(
                make_action("approve_payment", {"amount": 10, "vendor": f"V{i}"}, "mixed-session")
            )
        assert "PHI Access Volume" not in (r.result.violated_policy or ""), (
            "a payment must not count toward a patient-record limit"
        )

    async def test_a_malformed_limit_fails_loudly_rather_than_silently_disabling(self):
        from agentgate_engine.limits import LimitSpecError
        from agentgate_engine.policy_store import set_policies

        broken = (
            "broken.md",
            "# Broken\nSeverity: high\nApplies to: other\n"
            "Accumulate: average(toolArgs.amount)\nLimit: 10\n",
        )
        try:
            set_policies([broken])
            raise AssertionError("a malformed limit must raise, not be ignored")
        except LimitSpecError as err:
            assert "not supported" in str(err)
        finally:
            set_policies(None)
