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
            request_number="R-1042",
            approval_steps=["Department Head approval — Pending (Ana Diaz)"],
        )
        text = " ".join(ctx.as_prompt_lines(4_000))
        assert "2,100 remaining" in text
        assert "OVER budget" in text
        assert "NOT on the approved vendor list" in text
        assert "request R-1042" in text and "Department Head approval — Pending" in text
        # Zip's /approvals holds steps on a request; it never says who must sign at an amount.
        assert "at this amount" not in text

    def test_stays_quiet_when_zip_knows_nothing(self):
        assert ZipContext().as_prompt_lines(100) == []

    def test_says_so_when_zip_was_unreachable(self):
        text = " ".join(ZipContext(degraded=True, note="timeout").as_prompt_lines(0))
        assert "Zip unavailable" in text and "judge on policy alone" in text


class TestClient:
    async def test_assembles_budget_vendor_and_approval_steps(self):
        asked: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            asked.append(request)
            p = request.url.path
            if p.endswith("/budgets"):
                return httpx.Response(200, json={"data": [
                    {"name": "Marketing Q3", "remaining": 2100, "total": 80000,
                     "currency": "USD", "openCommitments": 15000}]})
            if p.endswith("/vendors"):
                return httpx.Response(200, json={"data": [{"name": "Acme", "status": "pending"}]})
            if p.endswith("/approvals"):
                return httpx.Response(200, json={"list": [
                    {"name": "Department Head", "display_status": "Pending",
                     "assignee": {"first_name": "Ana", "last_name": "Diaz", "email": "ana@example.com"}},
                    {"node_type": "approval", "status": 1},
                ]})
            return httpx.Response(404, json={})

        c = ZipClient("https://zip.test/v1", "tok")
        c._client = _ok(handler)
        ctx = await c.context_for(
            {"vendor": "Acme", "amount": 4000, "budget": "Marketing Q3", "request_number": "R-1042"}
        )

        assert ctx.budget and ctx.budget.remaining == 2100
        assert ctx.vendor_approved is False, "a 'pending' vendor is not approved"
        assert ctx.request_number == "R-1042"
        # Second step has only Zip's numeric status; 1 means "Ready to start" per Zip's docs.
        assert ctx.approval_steps == ["Department Head — Pending (Ana Diaz)", "approval — Ready to start"]
        assert "ana@example.com" not in " ".join(ctx.as_prompt_lines(4000)), "names only, never an email"
        approvals = [r for r in asked if r.url.path.endswith("/approvals")]
        assert [r.url.params["request_number"] for r in approvals] == ["R-1042"]
        assert ctx.open_commitments == 15000
        assert ctx.degraded is False

    async def test_approvals_are_never_asked_without_a_request_number(self):
        """/approvals searches every request. Without a request to scope it, the answer
        would be someone else's approvals presented as this action's."""
        asked: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            asked.append(request.url.path)
            return httpx.Response(200, json={"list": [{"name": "CFO", "display_status": "Pending"}], "total": 1})

        ctx = await _zip_client(handler).context_for({"vendor": "Acme", "amount": 4000})
        assert not any(p.endswith("/approvals") for p in asked)
        assert ctx.approval_steps == []

    async def test_a_request_with_no_steps_says_so(self):
        c = _zip_client(lambda r: httpx.Response(200, json={"list": [], "size": 0, "total": 0}))
        ctx = await c.context_for({"request_number": "R-9"})
        assert "no approval steps recorded on request R-9" in " ".join(ctx.as_prompt_lines(0))

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


def _zip_client(handler) -> ZipClient:
    c = ZipClient("https://zip.test", "tok")
    c._client = _ok(handler)
    return c


def _vendors(records, total=None):
    """A handler whose /vendors answers with Zip's {list, size, total} envelope."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/vendors"):
            return httpx.Response(
                200, json={"list": records, "size": len(records), "total": len(records) if total is None else total}
            )
        return httpx.Response(200, json={"list": [], "size": 0, "total": 0})

    return handler


class TestEmptyIsNotUnapproved:
    """The reported bug: Zip came back with nothing, and the client either said
    nothing or, worse, called a real vendor unapproved."""

    async def test_an_empty_vendor_list_is_not_reported_as_unapproved(self):
        ctx = await _zip_client(_vendors([])).context_for({"vendor": "Lemongrass Lemon Co", "amount": 400})
        assert ctx.vendor_approved is None
        text = " ".join(ctx.as_prompt_lines(400))
        assert "NOT on the approved vendor list" not in text
        assert "vendor list is empty" in text

    async def test_a_vendor_that_is_really_missing_is_still_flagged(self):
        c = _zip_client(_vendors([{"name": "Acme Supplies", "status": "active"}]))
        ctx = await c.context_for({"vendor": "Shady LLC", "amount": 400})
        assert ctx.vendor_approved is False

    async def test_a_paginated_first_page_cannot_prove_a_vendor_is_missing(self):
        # 1 of 40 returned: absence from this page says nothing about the rest.
        c = _zip_client(_vendors([{"name": "Acme Supplies", "status": "active"}], total=40))
        ctx = await c.context_for({"vendor": "Lemongrass Lemon Co", "amount": 400})
        assert ctx.vendor_approved is None
        assert "first 1 of 40" in " ".join(ctx.as_prompt_lines(400))

    async def test_a_vendor_is_found_by_id_not_only_by_name(self):
        c = _zip_client(_vendors([{"id": "v_123", "name": "Lemongrass Lemon Co", "status": "active"}]))
        ctx = await c.context_for({"vendor_id": "v_123", "amount": 400})
        assert ctx.vendor_approved is True
        assert ctx.vendor_name == "Lemongrass Lemon Co"


class TestJsonStringArguments:
    """Zip's MCP tools pass one `data` argument that is a JSON string."""

    def test_vendor_and_amount_are_found_inside_a_data_string(self):
        import json as _json

        from agentgate_engine.zip_client import _VENDOR_KEYS, _pick

        args = {"data": _json.dumps({"vendor_id": "10cd41f1", "currency": "USD", "amount": 400})}
        assert _pick(args, _VENDOR_KEYS) == "10cd41f1"
        assert extract_amount(args) == 400

    def test_line_items_inside_a_data_string_are_summed(self):
        import json as _json

        args = {"data": _json.dumps({"vendor_id": "v", "items": [{"total": 100}, {"total": 50}]})}
        assert extract_amount(args) == 150

    def test_text_that_is_not_json_is_left_alone(self):
        from agentgate_engine.zip_client import _expand

        assert _expand({"note": "{not json"}) == {"note": "{not json"}
        assert _expand({"n": "[1, 2"}) == {"n": "[1, 2"}


class TestVendorStatus:
    """Zip returns vendor status as a NUMBER; its filter uses words. A number we cannot
    read must never turn a real vendor into an unapproved one."""

    async def _ctx(self, status):
        c = _zip_client(_vendors([{"id": "v1", "name": "Acme", "status": status}]))
        return await c.context_for({"vendor_id": "v1", "amount": 400})

    async def test_a_numeric_status_is_unknown_not_unapproved(self):
        ctx = await self._ctx(7)  # an unverified code
        assert ctx.vendor_approved is None
        text = " ".join(ctx.as_prompt_lines(400))
        assert "NOT on the approved vendor list" not in text
        assert "status code for vendor 'Acme' is 7" in text

    async def test_code_5_is_a_draft_vendor_as_verified_live(self):
        ctx = await self._ctx(5)
        assert ctx.vendor_approved is False
        assert "DRAFT" in " ".join(ctx.notes) and "not yet onboarded" in " ".join(ctx.notes)

    async def test_code_1_is_an_active_vendor_as_verified_live(self):
        ctx = await self._ctx(1)
        assert ctx.vendor_approved is True

    async def test_zips_status_words_are_understood(self):
        assert (await self._ctx("PREFERRED")).vendor_approved is True
        assert (await self._ctx("ACTIVE")).vendor_approved is True
        assert (await self._ctx("BANNED")).vendor_approved is False
        assert (await self._ctx("INACTIVE")).vendor_approved is False
        draft = await self._ctx("DRAFT")
        assert draft.vendor_approved is False and "not yet onboarded" in " ".join(draft.notes)


class TestNestedArguments:
    def test_finds_a_vendor_inside_a_nested_object(self):
        from agentgate_engine.zip_client import _BUDGET_KEYS, _VENDOR_KEYS, _pick

        assert _pick({"request": {"vendor": {"id": "v_9", "name": "Acme"}}}, _VENDOR_KEYS) == "Acme"
        assert _pick({"request": {"vendor_id": "v_9"}}, _VENDOR_KEYS) == "v_9"
        assert _pick({"note": "hi"}, _BUDGET_KEYS) is None

    def test_sums_line_items_when_there_is_no_top_level_amount(self):
        args = {"vendor_id": "v_9", "line_items": [{"amount": 400}, {"price": "$250.50"}]}
        assert extract_amount(args) == 650.5

    def test_a_top_level_amount_wins_over_its_own_line_items(self):
        # Adding both would count the same money twice.
        assert extract_amount({"total": 900, "line_items": [{"amount": 400}, {"amount": 500}]}) == 900

    def test_a_dollar_string_amount_is_read(self):
        assert extract_amount({"amount": "$1,200"}) == 1200


class TestOnlyProcurementActionsAskZip:
    def test_money_and_workflow_tools_do(self):
        from agentgate_engine.zip_client import is_procurement_action as p

        for name in ("create_purchase_order", "approve_payment", "issue_refund", "zip_create_request",
                     "zip_approve_bill", "zip_upsert_budgets"):
            assert p(name), name

    def test_reads_and_unrelated_tools_do_not(self):
        from agentgate_engine.zip_client import is_procurement_action as p

        for name in ("check_budget", "zip_search_vendors", "lookup_customer", "send_email", "run_command", ""):
            assert not p(name), name


class TestConfigAcceptsZipsOwnNames:
    def test_the_docs_variable_names_turn_grounding_on(self, monkeypatch):
        from agentgate_engine.config import Config

        for name in ("ZIP_API_TOKEN", "ZIP_API_BASE", "ZIP_API_KEY", "ZIP_API_URL"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("ZIP_API_KEY", "doc-key")
        monkeypatch.setenv("ZIP_API_URL", "https://staging-api.zip.com")
        cfg = Config()
        assert cfg.zip_api_token == "doc-key"
        assert cfg.zip_api_base == "https://staging-api.zip.com"

    def test_the_original_names_still_win(self, monkeypatch):
        from agentgate_engine.config import Config

        monkeypatch.setenv("ZIP_API_TOKEN", "explicit")
        monkeypatch.setenv("ZIP_API_KEY", "doc-key")
        assert Config().zip_api_token == "explicit"


class TestStatus:
    def test_off_says_why_and_never_leaks_a_key(self):
        from agentgate_engine.config import config
        from agentgate_engine.zip_client import zip_status

        saved, config.zip_api_token = config.zip_api_token, ""
        try:
            s = zip_status()
            assert s["state"] == "off" and "ZIP_API_KEY" in s["reason"]
        finally:
            config.zip_api_token = saved

    async def test_on_then_degraded_when_a_lookup_fails(self):
        from agentgate_engine.config import config
        from agentgate_engine.zip_client import zip_status

        saved = config.zip_api_token
        config.zip_api_token = "secret-value"
        try:
            def boom(request: httpx.Request) -> httpx.Response:
                raise httpx.ConnectError("zip down")

            set_zip_client(_zip_client(_vendors([{"name": "Acme", "status": "active"}])))
            await zip_context({"vendor": "Acme", "amount": 10})
            assert zip_status()["state"] == "on"

            set_zip_client(_zip_client(boom))
            await zip_context({"vendor": "Acme", "amount": 10})
            status = zip_status()
            assert status["state"] == "degraded"
            assert "secret-value" not in str(status)
        finally:
            config.zip_api_token = saved


class TestEngineSaysSoWhenZipHasNothing:
    async def _run(self, harness, action, tool, args, handler):
        from agentgate_engine import evaluate_detailed
        from agentgate_engine.config import config

        harness()
        config.zip_api_token = "tok"  # harness() clears it; this test wants Zip on
        set_zip_client(_zip_client(handler))
        return await evaluate_detailed(action(tool, args))

    async def test_consulted_but_empty_is_stated_not_blank(self, harness, action):
        from agentgate_engine.zip_client import NO_DATA_LINE

        d = await self._run(harness, action, "create_purchase_order", {"vendor": "Lemongrass Lemon Co", "amount": 400}, _vendors([]))
        assert d.zip_facts and any("vendor list is empty" in f for f in d.zip_facts)

        d = await self._run(harness, action, "approve_payment", {"amount": 400}, _vendors([]))
        assert d.zip_facts == [NO_DATA_LINE]

    async def test_a_non_procurement_action_never_asks_zip(self, harness, action):
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            return httpx.Response(200, json={"list": [], "size": 0, "total": 0})

        d = await self._run(harness, action, "send_email", {"to": "a@b.com", "amount": 5}, handler)
        assert d.zip_facts is None
        assert calls == []
