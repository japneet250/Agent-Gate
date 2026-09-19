"""Provision and verify the engine's Cloudflare resources.

    ./venv/bin/python cloudflare_setup.py

Creates the Vectorize index if missing, creates the D1 session table if missing,
embeds all policies into Vectorize, and runs one real query end to end so you
know it works before the demo rather than during it.

Needs in the repo-root .env:
    CLOUDFLARE_ACCOUNT_ID=...
    CLOUDFLARE_API_TOKEN=...      # needs Vectorize:Edit and D1:Edit
    D1_DATABASE_ID=...            # optional; skip to leave sessions in memory
    VECTORIZE_INDEX=agentgate-policies
"""

from __future__ import annotations

import asyncio
import sys

import httpx

from agentgate_engine.cloudflare import (
    API_ROOT,
    D1SessionStore,
    VectorizeStore,
    _headers,
    cloudflare_configured,
)
from agentgate_engine.config import config
from agentgate_engine.policy_store import load_policies, retrieve_policies, warm_policy_index
from agentgate_engine.stores import SessionState, configure_stores

G, R, Y, X = "\033[32m", "\033[31m", "\033[33m", "\033[0m"
OK, BAD, WARN = f"{G}✔{X}", f"{R}✖{X}", f"{Y}!{X}"


async def verify_token() -> bool:
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(
            f"{API_ROOT}/accounts/{config.cloudflare_account_id}/tokens/verify",
            headers=_headers(config.cloudflare_api_token),
        )
    if res.status_code == 200 and res.json().get("success"):
        print(f"  {OK} API token valid")
        return True
    print(f"  {BAD} API token rejected: {res.status_code} {res.text[:200]}")
    return False


async def main() -> None:
    print("\nAgentGate — Cloudflare setup\n")

    if not cloudflare_configured():
        print(f"  {BAD} CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env")
        sys.exit(1)
    print(f"  account: {config.cloudflare_account_id[:8]}…")

    if not await verify_token():
        sys.exit(1)

    # --- Vectorize -----------------------------------------------------------
    print(f"\nVectorize index '{config.vectorize_index}'")
    vectors = VectorizeStore()
    try:
        await vectors.ensure_index()
        print(f"  {OK} index ready ({len(load_policies())} policies to embed)")
    except Exception as err:  # noqa: BLE001
        print(f"  {BAD} could not create index: {err}")
        sys.exit(1)

    configure_stores(vectors=vectors)
    if not await warm_policy_index():
        print(f"  {BAD} embedding failed — check OPENAI_API_KEY")
        sys.exit(1)
    print(f"  {OK} policies embedded and upserted")

    if vectors.degraded:
        print(f"  {WARN} upsert fell back to memory — Vectorize write did not land")

    # Vectorize is eventually consistent; a fresh index needs a moment.
    await asyncio.sleep(3)
    count = await vectors.size()
    print(f"  {OK if count else WARN} index reports {count} vectors")

    hits = await retrieve_policies(
        'Tool "send_email" with arguments: {"body":"SSN 123-45-6789"}. '
        "Detected in the payload: social security number personally identifiable information.",
        category="external_comms",
    )
    top = hits[0].name if hits else "(none)"
    live = any(h.dense_score > 0 for h in hits)
    print(f"  {OK if live else WARN} live query -> top hit: {top}"
          f"{'' if live else '  (no dense scores — served from fallback, not Vectorize)'}")

    # --- D1 ------------------------------------------------------------------
    if config.d1_database_id:
        print(f"\nD1 database {config.d1_database_id[:8]}…")
        sessions = D1SessionStore()
        try:
            await sessions.ensure_schema()
            print(f"  {OK} agentgate_sessions table ready")
            probe = SessionState(session_id="setup-probe", total_spend=1234.0)
            await sessions.save(probe)
            back = await sessions.get("setup-probe")
            if back.total_spend == 1234.0 and not sessions.degraded:
                print(f"  {OK} round-trip write/read confirmed")
            else:
                print(f"  {BAD} round-trip failed — sessions will stay in memory")
        except Exception as err:  # noqa: BLE001
            print(f"  {BAD} D1 unavailable: {err}")
        finally:
            await sessions.aclose()
    else:
        print(f"\n  {WARN} D1_DATABASE_ID not set — session state stays in memory.")
        print("      Create one with:  npx wrangler d1 create agentgate")

    await vectors.aclose()

    print(f"\n{G}Done.{X} Start the engine and check /health:")
    print("  ./venv/bin/uvicorn server:app --port 8000")
    print("  curl -s localhost:8000/health | python3 -m json.tool\n")


if __name__ == "__main__":
    asyncio.run(main())
