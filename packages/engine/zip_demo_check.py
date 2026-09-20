"""Where are we in Zip's demo workflow? Read-only.

    ./venv/bin/python zip_demo_check.py

Walks the steps of Zip's setup doc in order, shows the evidence for each from the live
API, and names the first step still to do. Prints counts and identifiers, never the key
and never a person's email.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass
from typing import Any

import httpx

from agentgate_engine.zip_client import ZipClient, zip_configured
from agentgate_engine.config import config

SUBSIDIARY = "Zip - Modern Spend Approvals"
VENDOR = "Lemongrass Lemon Co"


@dataclass
class Step:
    label: str
    done: bool
    evidence: str
    how: str  # what to do if it is not done


def _has(record: dict[str, Any], *words: str) -> bool:
    blob = str(record).lower()
    return all(w.lower() in blob for w in words)


def _status(record: dict[str, Any]) -> str:
    return str(record.get("display_status") or record.get("status") or "?")


async def _list(client: ZipClient, path: str) -> tuple[list[dict[str, Any]], int]:
    doc = await client._get(path)
    records = [r for r in (doc.get("list") or doc.get("data") or []) if isinstance(r, dict)]
    return records, int(doc.get("total", len(records)))


async def collect(client: ZipClient) -> list[Step]:
    subs, _ = await _list(client, "/subsidiaries")
    vendors, n_vendors = await _list(client, "/vendors")
    requests, n_requests = await _list(client, "/requests")
    pos, n_pos = await _list(client, "/purchase_orders")
    invoices, n_invoices = await _list(client, "/invoices")

    # Several attempts may exist; judge the workflow by the furthest one along (3/4 = approved).
    mine = [r for r in requests if _has(r, "lemongrass")] or requests[:1]
    ours = max(mine, key=lambda r: 1 if r.get("status") in (3, 4) else 0, default=None)
    vendor = next((v for v in vendors if VENDOR.lower() in str(v.get("name", "")).lower()), None)
    po = next((p for p in pos if _has(p, "lemongrass")), None) or (pos[0] if pos else None)
    bill = next((i for i in invoices if _has(i, "lemongrass")), None) or (invoices[0] if invoices else None)

    steps = [
        Step(
            f"Setup: key works, company has the '{SUBSIDIARY}' subsidiary",
            any(SUBSIDIARY.lower() == str(s.get("name", "")).lower() for s in subs),
            f"{len(subs)} subsidiaries: " + ", ".join(str(s.get("name")) for s in subs),
            "Ask #spons-zip-2026 — this key may belong to a different company",
        ),
        Step(
            "1. Request created from '[Do not EDIT] Basic Request a Purchase'",
            ours is not None,
            f"{n_requests} requests" + (f"; {ours.get('request_number')} is {_status(ours)}" if ours else ""),
            f"In Zip: New request → that workflow → subsidiary '{SUBSIDIARY}', add a line item, "
            f"payment method 'Purchase order', vendor '{VENDOR}'",
        ),
        Step(
            f"   …and '{VENDOR}' now exists as a vendor",
            vendor is not None,
            f"{n_vendors} vendors" + (f"; status {vendor.get('status')}" if vendor else ""),
            "Comes from choosing the vendor on the request (step 1.4)",
        ),
        Step(
            "2. Request finalized",
            bool(ours and (ours.get("complete_time") or ours.get("completed_at") or ours.get("status") in (3, 4) or "approved" in _status(ours).lower())),
            f"request status: {_status(ours)}" if ours else "no request yet",
            "In Zip: open the request → finalize / complete it",
        ),
        Step(
            "3. Purchase order created",
            po is not None,
            f"{n_pos} purchase orders" + (f"; PO {po.get('po_number')}" if po else ""),
            "Appears after the request is finalized; check Purchase orders in Zip",
        ),
        Step(
            "4-5. Bill created from the invoice PDF, linked to that PO",
            bill is not None,
            f"{n_invoices} invoices" + (f"; {bill.get('invoice_number')} is {_status(bill)}" if bill else ""),
            "In Zip: {your-domain}/bills → drop the invoice PDF, fast processing, pick the vendor and PO → Create bill",
        ),
        Step(
            "6. Bill approved",
            bool(bill and (bill.get("approved_at") or "approved" in _status(bill).lower())),
            f"bill status: {_status(bill)}" if bill else "no bill yet",
            "In Zip: open the bill → approve",
        ),
        Step(
            "7. Bill marked as paid",
            bool(bill and ("paid" in _status(bill).lower() or bill.get("payouts"))),
            f"bill status: {_status(bill)}" if bill else "no bill yet",
            "In Zip: open the bill → mark as paid",
        ),
    ]
    return steps


def render(steps: list[Step]) -> tuple[str, bool]:
    lines = ["Zip demo workflow, step by step", ""]
    first_todo: Step | None = None
    for s in steps:
        lines.append(f"  [{'x' if s.done else ' '}] {s.label}")
        lines.append(f"        {s.evidence}")
        if not s.done and first_todo is None:
            first_todo = s
    lines.append("")
    if first_todo is None:
        lines.append("All steps done. Zip has the data the judge needs.")
    else:
        lines.append(f"NEXT: {first_todo.label.strip()}")
        lines.append(f"      {first_todo.how}")
    return "\n".join(lines), first_todo is None


async def main() -> int:
    if not zip_configured():
        print("Zip is not configured: set ZIP_API_KEY (or ZIP_API_TOKEN) and ZIP_API_URL (or ZIP_API_BASE).")
        return 1
    client = ZipClient(config.zip_api_base, config.zip_api_token)
    try:
        steps = await collect(client)
    except httpx.HTTPStatusError as err:
        print(f"Zip answered HTTP {err.response.status_code}; run zip_probe.py to see why.")
        return 1
    except httpx.HTTPError as err:
        print(f"Zip unreachable: {type(err).__name__}")
        return 1
    text, done = render(steps)
    print(text)
    return 0 if done else 3


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
