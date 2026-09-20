"""Find out why Zip grounding comes back empty. Read-only.

    ./venv/bin/python zip_probe.py
    ./venv/bin/python zip_probe.py --tool create_purchase_order \\
        --args '{"vendor": "Lemongrass Lemon Co", "amount": 400}'

Reports, per source, whether it is working, empty or failing, and ends with one
verdict. It prints variable NAMES and record counts, never the key.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

import httpx

from agentgate_engine.config import config
from agentgate_engine.zip_client import (
    _BUDGET_KEYS,
    _VENDOR_KEYS,
    ZipClient,
    _pick,
    extract_amount,
    is_procurement_action,
    zip_configured,
)

ENV_NAMES = ("ZIP_API_KEY", "ZIP_API_URL", "ZIP_API_TOKEN", "ZIP_API_BASE")
DEFAULT_TOOL = "create_purchase_order"
DEFAULT_ARGS: dict[str, Any] = {"vendor": "Lemongrass Lemon Co", "amount": 400}


def _row(label: str, text: str) -> str:
    return f"  {label:<14} {text}"


def _names(records: list[dict[str, Any]], limit: int = 3) -> str:
    shown = [str(r.get("name") or r.get("display_name") or r.get("id") or "?") for r in records[:limit]]
    more = f" (+{len(records) - limit} more)" if len(records) > limit else ""
    return ", ".join(shown) + more if shown else "none"


async def _collection(client: ZipClient, label: str, path: str) -> tuple[str, int | None]:
    """One REST list endpoint -> (a printable row, the total or None on failure)."""
    try:
        doc = await client._get(path)
    except httpx.HTTPStatusError as err:
        code = err.response.status_code
        if code == 401:
            return _row(label, "AUTH FAILED (401) — key rejected or wrong company/host"), None
        if code == 405:
            return _row(label, "405 — this route cannot be read over REST"), None
        return _row(label, f"HTTP {code}"), None
    except httpx.HTTPError as err:
        return _row(label, f"UNREACHABLE — {type(err).__name__}"), None

    records = client._unwrap(doc)
    total = client._total(doc)
    n = total if total is not None else len(records)
    tag = "OK  " if n else "EMPTY"
    return _row(label, f"{tag} total={n}   {_names(records)}"), n


async def run_probe(
    client: ZipClient | None, tool: str, args: dict[str, Any], configured: bool
) -> tuple[list[str], str]:
    """Returns (report lines, verdict). Split out so it can be tested with a mock."""
    lines = ["Zip probe"]
    for name in ENV_NAMES:
        lines.append(_row(name, "set" if os.getenv(name) else "NOT set"))

    if not configured or client is None:
        lines.append(_row("grounding", "OFF — no key found under ZIP_API_KEY or ZIP_API_TOKEN"))
        return lines, "grounding is OFF. Set ZIP_API_KEY (or ZIP_API_TOKEN) in .env."

    lines.append(_row("host", client.base))

    vendors_row, vendors_n = await _collection(client, "/vendors", config.zip_vendors_path)
    approvals_row, approvals_n = await _collection(client, "/approvals", config.zip_approvals_path)
    lines += [vendors_row, approvals_row]
    lines.append(_row("/budgets (REST)", "expected 405 — Zip cannot read budgets at all (zip_search_budgets is 405 too)"))

    if vendors_n is None and approvals_n is None:
        return lines, "could not read Zip. Check the key, the host, and that the header is Zip-Api-Key."

    # What would the engine actually tell the judge for this call?
    ctx = await client.context_for(args)
    facts = ctx.as_prompt_lines(extract_amount(args))
    lines.append(_row("sample call", f"{tool} {json.dumps(args)}"))
    lines.append(_row("", f"asks Zip? {'yes' if is_procurement_action(tool) else 'NO — not a procurement tool'}"))
    lines.append(_row("", f"read vendor={_pick(args, _VENDOR_KEYS)!r} budget={_pick(args, _BUDGET_KEYS)!r} "
                          f"amount={extract_amount(args):g}"))
    if facts:
        lines.append(_row("", "facts the judge would see:"))
        lines += [f"                   - {f}" for f in facts]
    else:
        lines.append(_row("", "facts: (none)"))

    if not is_procurement_action(tool):
        return lines, "this tool name is not treated as procurement, so Zip is never asked."
    if not vendors_n and not approvals_n:
        return lines, "auth works but the company is empty. Run Zip's demo workflow once, then re-run."
    if not facts:
        return lines, "Zip has data, but nothing in these arguments matched it. Compare the arguments to the records above."
    return lines, "Zip grounding is working (vendor and approvals; budgets are unreadable in Zip)."


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tool", default=DEFAULT_TOOL)
    parser.add_argument("--args", default=json.dumps(DEFAULT_ARGS), help="tool arguments, as JSON")
    ns = parser.parse_args()
    try:
        args = json.loads(ns.args)
        assert isinstance(args, dict)
    except (json.JSONDecodeError, AssertionError):
        print("--args must be a JSON object", file=sys.stderr)
        return 2

    configured = zip_configured()
    client = ZipClient() if configured else None
    try:
        lines, verdict = await run_probe(client, ns.tool, args, configured)
    finally:
        if client:
            await client.aclose()
    print("\n".join(lines))
    print(f"\nverdict: {verdict}")
    return 0 if verdict.startswith("Zip grounding is working") else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
