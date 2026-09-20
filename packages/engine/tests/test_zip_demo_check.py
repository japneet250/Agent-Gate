"""The demo checker names the first unfinished step of Zip's workflow."""

from __future__ import annotations

import httpx

from agentgate_engine.zip_client import ZipClient
from zip_demo_check import collect, render


def _client(data: dict[str, list]) -> ZipClient:
    def handler(request: httpx.Request) -> httpx.Response:
        key = request.url.path.rsplit("/", 1)[-1]
        rows = data.get(key, [])
        return httpx.Response(200, json={"list": rows, "size": len(rows), "total": len(rows)})

    c = ZipClient("https://zip.test", "tok")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return c


SUB = [{"name": "Zip - Modern Spend Approvals"}]


async def test_empty_company_points_at_step_one():
    text, done = render(await collect(_client({"subsidiaries": SUB})))
    assert not done
    assert "NEXT: 1. Request created" in text


async def test_a_finalized_request_moves_the_next_step_to_the_bill():
    data = {
        "subsidiaries": SUB,
        "vendors": [{"name": "Lemongrass Lemon Co", "status": 1}],
        "requests": [{"request_number": "R-1", "display_status": "Approved", "vendor": {"name": "Lemongrass Lemon Co"}}],
        "purchase_orders": [{"po_number": "PO-1", "vendor": {"name": "Lemongrass Lemon Co"}}],
    }
    text, done = render(await collect(_client(data)))
    assert not done
    assert "NEXT: 4-5. Bill created" in text


async def test_everything_done():
    data = {
        "subsidiaries": SUB,
        "vendors": [{"name": "Lemongrass Lemon Co"}],
        "requests": [{"request_number": "R-1", "display_status": "Approved", "vendor": "Lemongrass Lemon Co"}],
        "purchase_orders": [{"po_number": "PO-1", "vendor": "Lemongrass Lemon Co"}],
        "invoices": [{"invoice_number": "I-1", "display_status": "Paid", "approved_at": 5, "vendor": "Lemongrass Lemon Co"}],
    }
    text, done = render(await collect(_client(data)))
    assert done and "All steps done" in text
