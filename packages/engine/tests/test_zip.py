"""Zip procurement grounding.

The point of these: a policy file can only guess ("over $500 needs approval").
Zip knows the real position. These check the engine actually uses it, and that
Zip being down degrades rather than breaking the firewall.
"""

from __future__ import annotations

import httpx
import pytest

from agentgate_engine.zip_client import (
    BudgetPosition,
    ZipClient,
    ZipContext,
    extract_amount,
    set_zip_client,
    zip_context,
)


def _ok(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def no_global_client():
    yield
    set_zip_client(None)


class TestBudgetMath:
    def test_reports_the_position_after_the_purchase(self):
        b = BudgetPosition(name="Marketing Q3", remaining=2_100, total=80_000)
        assert b.used_fraction == pytest.approx(0.97375)
        # $4,000 against $2,100 remaining takes it over.
        assert b.after(4_000) > 1.0

    def test_a_zero_budget_does_not_divide_by_zero(self):
        b = BudgetPosition(name="unset", remaining=0, total=0)
        assert b.used_fraction == 0.0
        assert b.after(500) == 0.0


class TestArgumentExtraction:
    def test_finds_the_amount_across_spellings(self):
        assert extract_amount({"amount": 4000}) == 4000
        assert extract_amount({"totalCost": 1250}) == 1250
        assert extract_amount({"vendor": "Acme"}) == 0


class TestPromptLines:
    def test_says_plainly_when_a_purchase_goes_over_budget(self):
        ctx = ZipContext(
            budget=BudgetPosition("Marketing Q3", remaining=2_100, total=80_000),
            vendor_name="Acme", vendor_approved=False,
            approvers_required=["Department Head", "CFO"],
        )
        text = " ".join(ctx.as_prompt_lines(4_000))
        assert "2,100 remaining" in text
        assert "OVER budget" in text
        assert "NOT on the approved vendor list" in text
        assert "CFO" in text

    def test_stays_quiet_when_zip_knows_nothing(self):
        assert ZipContext().as_prompt_lines(100) == []

    def test_says_so_when_zip_was_unreachable(self):
        text = " ".join(ZipContext(degraded=True, note="timeout").as_prompt_lines(0))
        assert "Zip unavailable" in text and "judge on policy alone" in text


class TestClient:
    async def test_assembles_budget_vendor_and_approval_chain(self):
        def handler(request: httpx.Request) -> httpx.Response:
            p = request.url.path
            if p.endswith("/budgets"):
                return httpx.Response(200, json={"data": [
                    {"name": "Marketing Q3", "remaining": 2100, "total": 80000,
                     "currency": "USD", "openCommitments": 15000}]})
            if p.endswith("/vendors"):
                return httpx.Response(200, json={"data": [{"name": "Acme", "status": "pending"}]})
            if p.endswith("/approvals"):
                return httpx.Response(200, json={"data": [
                    {"role": "Department Head"}, {"role": "CFO"}]})
            return httpx.Response(404, json={})

        c = ZipClient("https://zip.test/v1", "tok")
        c._client = _ok(handler)
        ctx = await c.context_for({"vendor": "Acme", "amount": 4000, "budget": "Marketing Q3"})

        assert ctx.budget and ctx.budget.remaining == 2100
        assert ctx.vendor_approved is False, "a 'pending' vendor is not approved"
        assert ctx.approvers_required == ["Department Head", "CFO"]
        assert ctx.open_commitments == 15000
        assert ctx.degraded is False

    async def test_a_failing_endpoint_degrades_rather_than_raising(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/vendors"):
                raise httpx.ConnectError("zip down")
            return httpx.Response(200, json={"data": []})

        c = ZipClient("https://zip.test/v1", "tok")
        c._client = _ok(handler)
        ctx = await c.context_for({"vendor": "Acme", "amount": 100, "budget": "Q3"})
        assert ctx.degraded is True, "must report the gap, not pretend"

    async def test_zip_context_returns_none_when_not_configured(self):
        set_zip_client(None)
        from agentgate_engine.config import config

        saved, config.zip_api_token = config.zip_api_token, ""
        try:
            assert await zip_context({"amount": 100}) is None
        finally:
            config.zip_api_token = saved
