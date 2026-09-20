"""Zip procurement context.

A spending limit in a markdown file is a guess. Zip holds the real thing: what
budget this purchase draws on and how much of it is left, whether the vendor is
actually onboarded, and who has to sign off at this amount.

So AgentGate does not ask "is $4,000 over our limit". It asks Zip, and then the
judge reasons about a real position:

    Marketing Q3 has $2,100 of $80,000 remaining. This $4,000 purchase order
    would take it 5% over budget. The approval chain at this amount requires
    the department head, who has not signed off.

That is the difference between a policy engine that guesses and one that knows.

Endpoints are configurable because a vendor API is not ours to pin: set
ZIP_API_BASE and the paths below if they differ. Every call fails soft — Zip
being unreachable degrades the judge to policy-only reasoning rather than
taking the firewall down.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import config


@dataclass
class BudgetPosition:
    name: str
    remaining: float
    total: float
    currency: str = "USD"

    @property
    def used_fraction(self) -> float:
        return 0.0 if self.total <= 0 else (self.total - self.remaining) / self.total

    def after(self, amount: float) -> float:
        """What fraction of the budget would be consumed if this goes through."""
        return 0.0 if self.total <= 0 else (self.total - self.remaining + amount) / self.total


@dataclass
class ZipContext:
    """What Zip knows that a policy file cannot."""

    budget: BudgetPosition | None = None
    vendor_name: str | None = None
    vendor_approved: bool | None = None
    approvers_required: list[str] = field(default_factory=list)
    open_commitments: float | None = None
    degraded: bool = False
    note: str = ""

    def as_prompt_lines(self, amount: float) -> list[str]:
        """Facts for the judge. Plain sentences, no thresholds — the judge is
        told what IS, and the policies decide what that means."""
        lines: list[str] = []
        if self.budget:
            b = self.budget
            lines.append(
                f"budget '{b.name}': {b.currency} {b.remaining:,.0f} remaining of "
                f"{b.total:,.0f} ({b.used_fraction:.0%} already committed)"
            )
            if amount > 0:
                after = b.after(amount)
                over = " — this would take it OVER budget" if after > 1.0 else ""
                lines.append(f"this action would bring the budget to {after:.0%} of its total{over}")
        if self.vendor_name:
            status = (
                "on the approved vendor list" if self.vendor_approved
                else "NOT on the approved vendor list" if self.vendor_approved is False
                else "approval status unknown"
            )
            lines.append(f"vendor '{self.vendor_name}' is {status}")
        if self.approvers_required:
            lines.append(
                "Zip's approval chain at this amount requires: "
                + ", ".join(self.approvers_required)
            )
        if self.open_commitments is not None:
            lines.append(f"open commitments not yet invoiced: {self.open_commitments:,.0f}")
        if self.degraded and self.note:
            lines.append(f"(Zip unavailable: {self.note} — judge on policy alone)")
        return lines


def zip_configured() -> bool:
    return bool(config.zip_api_token and config.zip_api_base)


_AMOUNT_KEYS = ("amount", "total", "price", "cost", "value")
_VENDOR_KEYS = ("vendor", "supplier", "payee", "merchant", "vendorname")
_BUDGET_KEYS = ("budget", "department", "costcenter", "cost_center", "glcode")


def _pick(args: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for k, v in (args or {}).items():
        if any(key in k.lower().replace("_", "") for key in keys):
            return v
    return None


def extract_amount(args: dict[str, Any]) -> float:
    raw = _pick(args, _AMOUNT_KEYS)
    try:
        return float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


class ZipClient:
    """Read side of Zip, used to ground a decision in real procurement state."""

    def __init__(self, base: str | None = None, token: str | None = None, timeout: float = 6.0):
        self.base = (base or config.zip_api_base).rstrip("/")
        self._token = token or config.zip_api_token
        self._client = httpx.AsyncClient(timeout=timeout)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        res = await self._client.get(f"{self.base}{path}", headers=self._headers(), params=params)
        res.raise_for_status()
        return res.json()

    async def context_for(self, tool_args: dict[str, Any]) -> ZipContext:
        """Everything Zip can tell us about this purchase, fetched concurrently.

        The judge is on a latency budget, so three sequential round trips would
        be felt; these are independent, so they go together.
        """
        amount = extract_amount(tool_args)
        vendor = _pick(tool_args, _VENDOR_KEYS)
        budget = _pick(tool_args, _BUDGET_KEYS)

        try:
            budget_doc, vendor_doc, chain_doc = await asyncio.gather(
                self._budget(budget), self._vendor(vendor), self._approval_chain(amount, budget),
                return_exceptions=True,
            )
        except Exception as err:  # noqa: BLE001
            return ZipContext(degraded=True, note=str(err)[:120])

        ctx = ZipContext()
        for doc, label in ((budget_doc, "budget"), (vendor_doc, "vendor"), (chain_doc, "approvals")):
            if isinstance(doc, Exception):
                ctx.degraded = True
                ctx.note = f"{label}: {str(doc)[:80]}"

        if isinstance(budget_doc, dict) and budget_doc:
            ctx.budget = BudgetPosition(
                name=str(budget_doc.get("name") or budget or "budget"),
                remaining=float(budget_doc.get("remaining") or 0),
                total=float(budget_doc.get("total") or budget_doc.get("amount") or 0),
                currency=str(budget_doc.get("currency") or "USD"),
            )
            oc = budget_doc.get("openCommitments")
            ctx.open_commitments = float(oc) if oc is not None else None

        if isinstance(vendor_doc, dict) and vendor_doc:
            ctx.vendor_name = str(vendor_doc.get("name") or vendor or "")
            status = str(vendor_doc.get("status", "")).lower()
            ctx.vendor_approved = status in ("approved", "active", "onboarded")
        elif vendor:
            ctx.vendor_name = str(vendor)

        if isinstance(chain_doc, list):
            ctx.approvers_required = [
                str(s.get("role") or s.get("name") or s) for s in chain_doc
            ][:5]

        return ctx

    # --- endpoints, kept separate so a path change is a one-line edit --------

    async def _budget(self, budget: Any) -> dict[str, Any] | None:
        if not budget:
            return None
        docs = await self._get(config.zip_budgets_path, {"q": str(budget)})
        items = docs.get("data", docs) if isinstance(docs, dict) else docs
        return items[0] if isinstance(items, list) and items else (items or None)

    async def _vendor(self, vendor: Any) -> dict[str, Any] | None:
        if not vendor:
            return None
        docs = await self._get(config.zip_vendors_path, {"q": str(vendor)})
        items = docs.get("data", docs) if isinstance(docs, dict) else docs
        return items[0] if isinstance(items, list) and items else (items or None)

    async def _approval_chain(self, amount: float, budget: Any) -> list[dict[str, Any]] | None:
        if amount <= 0:
            return None
        docs = await self._get(
            config.zip_approvals_path, {"amount": amount, "budget": str(budget or "")}
        )
        items = docs.get("data", docs) if isinstance(docs, dict) else docs
        return items if isinstance(items, list) else None

    async def aclose(self) -> None:
        await self._client.aclose()


_client: ZipClient | None = None


def zip_client() -> ZipClient | None:
    global _client
    if not zip_configured():
        return None
    if _client is None:
        _client = ZipClient()
    return _client


def set_zip_client(client: ZipClient | None) -> None:
    """Test seam."""
    global _client
    _client = client


async def zip_context(tool_args: dict[str, Any]) -> ZipContext | None:
    """Zip facts for this action, or None when Zip is not configured."""
    client = zip_client()
    if client is None:
        return None
    try:
        return await client.context_for(tool_args)
    except Exception as err:  # noqa: BLE001 — Zip must never take the judge down
        print(f"[agentgate] Zip lookup failed, judging on policy alone: {err}")
        return ZipContext(degraded=True, note=str(err)[:120])
