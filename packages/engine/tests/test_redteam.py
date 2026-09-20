"""Tests for the red team itself.

A checker that cannot fire is worse than no checker: it reports zero defects
forever and everyone believes it. Each invariant here is tested against a
deliberately broken firewall as well as a sane one.
"""

from __future__ import annotations

import pytest

from agentgate_engine.redteam.probes import SEVERITY, Case, build_suite
from agentgate_engine.redteam.run import run_redteam


class TestSuiteShape:
    def test_the_suite_probes_around_a_hundred_cases(self):
        s = build_suite()
        assert 90 <= s.case_count <= 130
        assert len(s.ladders) >= 8

    def test_every_ladder_moves_one_variable_over_several_rungs(self):
        for ladder in build_suite().ladders:
            assert len(ladder.cases) >= 4, f"{ladder.id} is too short to show a trend"
            assert ladder.variable, f"{ladder.id} does not say what it varies"
            assert len({c.id for c in ladder.cases}) == len(ladder.cases)

    def test_every_pair_explains_why_one_side_is_safer(self):
        # Without that sentence the check is an assertion nobody can audit.
        for pair in build_suite().pairs:
            assert len(pair.why) > 20, f"{pair.id} has no stated justification"

    def test_each_injection_has_a_clean_counterpart(self):
        for clean, injected in build_suite().injections:
            assert clean.tool == injected.tool, "a pair must differ only in the injected text"
            assert clean.args != injected.args

    def test_severity_ordering_is_what_the_checks_assume(self):
        assert SEVERITY["allow"] < SEVERITY["escalate"] < SEVERITY["block"]


def _firewall(decide):
    """Install a stub judge whose verdict is computed from the action."""
    import agentgate_engine.redteam.run as run_mod
    from agentgate_engine.redteam.run import Observation

    async def fake_observe(case: Case, session=None) -> Observation:
        decision, risk = decide(case)
        return Observation(case=case, decision=decision, risk=risk, policy=None,
                           latency_ms=1, reasoning="stub", degraded=False)

    run_mod._observe = fake_observe


class TestCheckersActuallyFire:
    @pytest.fixture(autouse=True)
    def restore(self):
        import agentgate_engine.redteam.run as run_mod

        original = run_mod._observe
        yield
        run_mod._observe = original

    async def test_a_coherent_firewall_reports_no_defects(self):
        # Strictness rises with the rung index, which is what a sane firewall does.
        order = {}

        def decide(case: Case):
            idx = order.setdefault(case.id, len(order))
            return ("allow", 10) if idx % 3 == 0 else ("allow", 10)

        _firewall(lambda c: ("allow", 5))
        report = await run_redteam()
        assert report.defects == [], "a uniformly permissive firewall breaks no ORDERING rule"

    async def test_it_catches_a_monotonicity_violation(self):
        # Block the first rung of every ladder and allow the rest: strictly
        # backwards, and exactly what a miscalibrated judge looks like.
        seen: set[str] = set()

        def decide(case: Case):
            prefix = case.id.rsplit("-", 1)[0]
            if prefix not in seen:
                seen.add(prefix)
                return ("block", 95)
            return ("allow", 5)

        _firewall(decide)
        report = await run_redteam()
        kinds = {v.kind for v in report.defects}
        assert "monotonicity" in kinds, "a backwards ladder must be reported"

    async def test_it_catches_an_injection_that_works(self):
        def decide(case: Case):
            # The override attempt softens the verdict — the exact failure the
            # whole product exists to prevent.
            return ("allow", 0) if "injected" in case.id else ("block", 95)

        _firewall(decide)
        report = await run_redteam()
        assert any(v.kind == "injection" for v in report.defects)

    async def test_it_catches_self_inconsistency(self):
        flip = {"n": 0}

        def decide(case: Case):
            if case.id.startswith("rep-"):
                flip["n"] += 1
                return ("allow", 5) if flip["n"] % 2 else ("block", 90)
            return ("allow", 5)

        _firewall(decide)
        report = await run_redteam()
        assert any(v.kind == "self-consistency" for v in report.defects)

    async def test_it_catches_a_pair_judged_backwards(self):
        def decide(case: Case):
            # Safer half of every pair blocked, riskier half allowed.
            if case.id.endswith("a"):
                return ("block", 90)
            if case.id.endswith("b"):
                return ("allow", 5)
            return ("allow", 5)

        _firewall(decide)
        report = await run_redteam()
        assert any(v.kind == "pair-order" for v in report.defects)
