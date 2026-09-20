"""The probe must name the real cause, and must never print the key."""

from __future__ import annotations

import httpx

from agentgate_engine.zip_client import ZipClient
from zip_probe import run_probe

SECRET = "sk-super-secret-key-value"
SAMPLE = {"vendor": "Lemongrass Lemon Co", "amount": 400}


def _client(handler) -> ZipClient:
    c = ZipClient("https://staging-api.zip.com", SECRET)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return c


def _populated(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/vendors"):
        rec = [{"id": "v_1", "name": "Lemongrass Lemon Co", "status": "active"}]
        return httpx.Response(200, json={"list": rec, "size": 1, "total": 1})
    if request.url.path.endswith("/approvals"):
        return httpx.Response(200, json={"list": [{"role": "Department Head"}], "size": 1, "total": 1})
    return httpx.Response(405, json={})


def _empty(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith(("/vendors", "/approvals")):
        return httpx.Response(200, json={"list": [], "size": 0, "total": 0})
    return httpx.Response(405, json={})


async def test_healthy_company_reports_working():
    lines, verdict = await run_probe(_client(_populated), "create_purchase_order", SAMPLE, True)
    text = "\n".join(lines)
    assert verdict.startswith("Zip grounding is working")
    assert "Lemongrass Lemon Co" in text and "on the approved vendor list" in text


async def test_an_empty_company_is_named_as_such():
    _, verdict = await run_probe(_client(_empty), "create_purchase_order", SAMPLE, True)
    assert "company is empty" in verdict


async def test_no_key_is_named_as_grounding_off():
    lines, verdict = await run_probe(None, "create_purchase_order", SAMPLE, False)
    assert "OFF" in verdict and "ZIP_API_KEY" in verdict
    assert any("NOT set" in line or "set" in line for line in lines)


async def test_a_rejected_key_is_reported_as_an_auth_failure():
    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "The provided API key is not valid"})

    lines, verdict = await run_probe(_client(reject), "create_purchase_order", SAMPLE, True)
    assert any("AUTH FAILED" in line for line in lines)
    assert "could not read Zip" in verdict


async def test_a_non_procurement_tool_is_called_out():
    _, verdict = await run_probe(_client(_populated), "send_email", SAMPLE, True)
    assert "not treated as procurement" in verdict


async def test_the_key_is_never_printed():
    for handler in (_populated, _empty):
        lines, verdict = await run_probe(_client(handler), "create_purchase_order", SAMPLE, True)
        assert SECRET not in "\n".join(lines) + verdict
