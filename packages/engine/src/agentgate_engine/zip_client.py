"""Zip procurement context.

A spending limit in a markdown file is a guess. Zip holds the real thing: what
budget this purchase draws on and how much of it is left, whether the vendor is
actually onboarded, and who has to sign off at this amount.

So AgentGate does not ask "is $4,000 over our limit". It asks Zip, and then the
judge reasons about a real position:

    Marketing Q3 has $2,100 of $80,000 remaining. This $4,000 purchase order
    would take it 5% over budget. Request R-1042's department-head approval
    is still pending.

That is the difference between a policy engine that guesses and one that knows.

Endpoints are configurable because a vendor API is not ours to pin: set
ZIP_API_BASE and the paths below if they differ. Every call fails soft — Zip
being unreachable degrades the judge to policy-only reasoning rather than
taking the firewall down.

Silence is never the answer. When Zip is consulted and has nothing to say, the
judge is told that, and /health reports whether grounding is on at all.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

import httpx

from .config import config

#: What the judge is told when Zip was asked and had nothing useful to say.
#: Deliberately not an empty list: an empty `zipFacts` is indistinguishable from
#: "grounding is off", which is exactly the confusion this replaces.
NO_DATA_LINE = "Zip returned no vendor or budget data for this action — judged on policy alone"


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
    #: The request these approval steps belong to, and the steps themselves
    #: ("Manager approval — Pending (Ana Diaz)"). Zip's /approvals holds approval
    #: steps ON a request; it does not say who must sign at an amount.
    request_number: str | None = None
    approval_steps: list[str] = field(default_factory=list)
    open_commitments: float | None = None
    degraded: bool = False
    note: str = ""
    #: Plain-sentence findings that are not a budget, vendor or approver fact —
    #: mostly "I could not check this, and here is why".
    notes: list[str] = field(default_factory=list)

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
        if self.approval_steps:
            lines.append(
                f"Zip's approval steps on request {self.request_number}: "
                + "; ".join(self.approval_steps)
            )
        if self.open_commitments is not None:
            lines.append(f"open commitments not yet invoiced: {self.open_commitments:,.0f}")
        lines.extend(self.notes)
        if self.degraded and self.note:
            lines.append(f"(Zip unavailable: {self.note} — judge on policy alone)")
        return lines


def zip_configured() -> bool:
    return bool(config.zip_api_token and config.zip_api_base)


# --- deciding whether an action is worth asking Zip about --------------------

# Read verbs are checked first so `check_budget` and `zip_search_vendors` are
# reads, not purchases. Same ordering rule as the classifier's heuristic.
_READ_VERB = re.compile(
    r"^(?:zip[_-])?(get|list|search|read|find|lookup|check|describe|view|show|fetch|query)", re.I
)
_PROCUREMENT = re.compile(
    r"(purchase|order|invoice|bill|payment|pay|refund|charge|transfer|payout|vendor|budget|"
    r"approv|request|spend|reimburs|expense|contract)",
    re.I,
)


def is_procurement_action(tool_name: str | None) -> bool:
    """Whether Zip has anything to say about this tool call.

    A customer lookup has no budget to consult and the round trip is not free,
    so only money-moving and procurement-workflow tools are grounded.
    """
    name = tool_name or ""
    if _READ_VERB.match(name):
        return False
    return bool(_PROCUREMENT.search(name))


# --- reading arguments -------------------------------------------------------

_AMOUNT_KEYS = ("amount", "total", "price", "cost", "value")
_VENDOR_KEYS = ("vendor", "supplier", "payee", "merchant", "vendorname")
_BUDGET_KEYS = ("budget", "department", "costcenter", "cost_center", "glcode")
# Zip's /approvals is filtered by request_number; without one there is nothing meaningful to ask.
_REQUEST_KEYS = ("requestnumber", "requestid")


def _expand(obj: Any, depth: int = 0) -> Any:
    """Zip's MCP write tools take one argument, `data`, that is a JSON *string*
    (`{"data": "{\\"vendor_id\\": ..., \\"items\\": [...]}"}`). Decode those so the
    vendor, amount and request number inside are found like any other argument.
    Bounded, and anything that is not valid JSON is left exactly as it was."""
    if depth > 3:
        return obj
    if isinstance(obj, dict):
        return {k: _expand(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand(v, depth + 1) for v in obj[:50]]
    if isinstance(obj, str) and obj[:1] in "{[" and len(obj) < 20000:
        try:
            return _expand(json.loads(obj), depth + 1)
        except ValueError:
            return obj
    return obj


def _walk(obj: Any, depth: int = 0) -> Iterator[tuple[str, Any]]:
    """Every (key, value) pair in nested arguments, depth-limited.

    Zip's real calls carry ids and line items inside nested objects, so a
    top-level-only scan finds nothing on them.
    """
    if depth > 4:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield str(k), v
            yield from _walk(v, depth + 1)
    elif isinstance(obj, list):
        for item in obj[:50]:
            yield from _walk(item, depth + 1)


def _scalar(value: Any) -> Any:
    """Reduce `{"id": ..., "name": ...}` or `[...]` to the thing worth looking up."""
    if isinstance(value, dict):
        return value.get("name") or value.get("id") or None
    if isinstance(value, list):
        return _scalar(value[0]) if value else None
    return value


def _key_matches(key: str, keys: tuple[str, ...]) -> bool:
    flat = key.lower().replace("_", "")
    return any(k in flat for k in keys)


def _pick(args: dict[str, Any], keys: tuple[str, ...]) -> Any:
    """First argument whose name looks like one of `keys`. Top level wins; nested
    arguments are searched only if the top level has nothing."""
    args = _expand(args or {})
    for k, v in args.items():
        if _key_matches(str(k), keys) and _scalar(v) not in (None, ""):
            return _scalar(v)
    for k, v in _walk(args):
        if _key_matches(k, keys) and _scalar(v) not in (None, ""):
            return _scalar(v)
    return None


def _to_float(raw: Any) -> float:
    if isinstance(raw, bool):
        return 0.0
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        try:
            return float(raw.replace("$", "").replace(",", "").strip())
        except ValueError:
            return 0.0
    return 0.0


def _nested_amount(obj: Any, depth: int = 0) -> float:
    """An amount key on a nested OBJECT (e.g. inside a decoded `data`). Lists are not
    entered, so a line item's own total is never mistaken for the order's."""
    if depth > 3 or not isinstance(obj, dict):
        return 0.0
    for v in obj.values():
        if isinstance(v, dict):
            found = _to_float(next((x for k, x in v.items() if _key_matches(str(k), _AMOUNT_KEYS)), None))
            if found:
                return found
            found = _nested_amount(v, depth + 1)
            if found:
                return found
    return 0.0


def extract_amount(args: dict[str, Any]) -> float:
    """The amount at stake. A top-level amount wins; failing that, the amounts of
    the line items inside a list are summed (a nested total is never added on top
    of its own items).

    ASSUMPTION, unverified against real Zip calls: that a purchase request's
    amounts live in `amount`/`price`/`total`-style keys on its line items. The
    probe (zip_probe.py) prints the real shape.
    """
    args = _expand(args or {})
    top = _to_float(
        next((v for k, v in args.items() if _key_matches(str(k), _AMOUNT_KEYS)), None)
    )
    if top:
        return top
    nested = _nested_amount(args)
    if nested:
        return nested
    total = 0.0
    for _, value in _walk(args):
        if isinstance(value, list):
            for item in value[:50]:
                if isinstance(item, dict):
                    total += _to_float(
                        next((v for k, v in item.items() if _key_matches(str(k), _AMOUNT_KEYS)), None)
                    )
    return total


# --- the client --------------------------------------------------------------


@dataclass
class VendorLookup:
    """What a vendor search actually established.

    `absent` is the only state that means "Zip has vendors and this is not one of
    them". The others are gaps in what we could see, and must never be reported
    as the vendor being unapproved.
    """

    record: dict[str, Any] | None
    state: str  # found | absent | empty | partial
    listed: int = 0
    total: int | None = None


# Zip's documented meaning of an approval node's numeric `status` (GET /approvals).
_APPROVAL_STATUS = {
    0: "Upcoming",
    1: "Ready to start",
    2: "Rejected",
    3: "Approved",
    4: "Approved automatically",
    5: "Canceled",
}

# GET /vendors?status= accepts exactly: INITIAL, ACTIVE, PREFERRED, INACTIVE, BANNED, DRAFT,
# DELETED (read from the API's own 400 message). Words are used when Zip sends them.
# Numeric codes are added only once verified against the live API (filter `status=DRAFT`
# returned a vendor whose `status` was 5, and `status=ACTIVE` one whose status was 1). The rest
# are unknown, so they are not guessed.
_VENDOR_CODE = {1: "ACTIVE", 5: "DRAFT"}
_VENDOR_OK = {"ACTIVE", "PREFERRED", "APPROVED", "ONBOARDED"}
_VENDOR_NOT_OK = {"INACTIVE", "BANNED", "DELETED"}
_VENDOR_PENDING = {"INITIAL", "DRAFT", "PENDING"}

_ID_FIELDS = ("id", "vendor_id", "external_id", "uuid")
_NAME_FIELDS = ("name", "display_name", "legal_name", "title")


class ZipClient:
    """Read side of Zip, used to ground a decision in real procurement state."""

    def __init__(self, base: str | None = None, token: str | None = None, timeout: float = 6.0):
        self.base = (base or config.zip_api_base).rstrip("/")
        self._token = token or config.zip_api_token
        self._client = httpx.AsyncClient(timeout=timeout)
        # Zip's REST API does not offer a readable budget route: /budgets allows
        # only OPTIONS and PUT. Budget state lives behind their MCP server
        # (zip_search_budgets). Once we have seen the 405 there is no point
        # paying for the round trip on every financial action, or flagging the
        # context degraded for a call that can never succeed.
        self._budgets_readable = True

    def _headers(self) -> dict[str, str]:
        # Zip uses its own header, NOT Authorization: Bearer. With Bearer the API
        # answers "The provided API key is not valid", which reads like a bad key
        # and is not — it cost a round of debugging to find that out.
        return {"Zip-Api-Key": self._token, "Accept": "application/json"}

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
        request_number = _pick(tool_args, _REQUEST_KEYS)

        try:
            budget_doc, vendor_res, approvals_doc = await asyncio.gather(
                self._budget(budget), self._vendor(vendor), self._approvals(request_number),
                return_exceptions=True,
            )
        except Exception as err:  # noqa: BLE001
            return ZipContext(degraded=True, note=str(err)[:120])

        ctx = ZipContext()
        for doc, label in ((budget_doc, "budget"), (vendor_res, "vendor"), (approvals_doc, "approvals")):
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

        if isinstance(vendor_res, VendorLookup):
            self._apply_vendor(ctx, vendor_res, vendor)

        if isinstance(approvals_doc, list):
            ctx.request_number = str(request_number)
            if approvals_doc:
                ctx.approval_steps = [self._describe_step(s) for s in approvals_doc[:6]]
            else:
                ctx.notes.append(f"Zip has no approval steps recorded on request {request_number}")

        return ctx

    @staticmethod
    def _describe_step(step: dict[str, Any]) -> str:
        """One approval step as a sentence fragment. Uses Zip's display text and the
        assignee's NAME only — an email would end up in logs and on screen.

        Zip's own `display_status` wins. Failing that, the numeric `status` is mapped
        with the meanings from Zip's API collection (0-5). 6-8 are custom statuses whose
        name lives in `node_status`; an unmapped code is shown as-is rather than guessed.
        """
        label = str(step.get("name") or step.get("node_type") or "approval")
        code = step.get("status")
        custom = step.get("node_status")
        status = (
            step.get("display_status")
            or (custom.get("name") if isinstance(custom, dict) else None)
            or _APPROVAL_STATUS.get(code)
            or code
        )
        who = step.get("assignee") or {}
        person = " ".join(str(who.get(k)) for k in ("first_name", "last_name") if who.get(k)) if isinstance(who, dict) else ""
        out = label if status in (None, "") else f"{label} — {status}"
        return f"{out} ({person})" if person else out

    @staticmethod
    def _apply_vendor(ctx: ZipContext, res: VendorLookup, wanted: Any) -> None:
        if res.state == "found" and res.record is not None:
            record = res.record
            ctx.vendor_name = str(record.get("name") or record.get("display_name") or wanted or "")
            raw = record.get("status")
            if isinstance(raw, int) and not isinstance(raw, bool) and raw in _VENDOR_CODE:
                raw = _VENDOR_CODE[raw]
            status = str(raw if raw is not None else "").strip().upper()
            if isinstance(raw, int) and not isinstance(raw, bool):
                # Zip returns vendor status as a number, and the collection does not say
                # what the numbers mean. Guessing would call a real vendor unapproved.
                ctx.vendor_approved = None
                ctx.notes.append(f"Zip's status code for vendor '{ctx.vendor_name}' is {raw} (meaning not documented)")
            elif status in _VENDOR_OK:
                ctx.vendor_approved = True
            elif status in _VENDOR_NOT_OK:
                ctx.vendor_approved = False
                ctx.notes.append(f"Zip lists vendor '{ctx.vendor_name}' as {status}")
            elif status in _VENDOR_PENDING:
                # Still being onboarded: genuinely not on the approved list, and says why.
                ctx.vendor_approved = False
                ctx.notes.append(f"Zip lists vendor '{ctx.vendor_name}' as {status} — not yet onboarded")
            else:
                # No usable status: is_active stands in.
                ctx.vendor_approved = bool(record.get("is_active")) if "is_active" in record else None
        elif res.state == "absent":
            # Zip has vendors, the caller named one, and it is not among them —
            # that IS the finding, not a gap. An unknown payee is the invoice-fraud vector.
            ctx.vendor_name = str(wanted)
            ctx.vendor_approved = False
        elif res.state == "empty":
            # No records at all. That says the company is unpopulated, not that
            # this vendor is unapproved, so it must not be reported as one.
            ctx.notes.append(
                f"Zip's vendor list is empty, so vendor '{wanted}' could not be checked"
            )
        elif res.state == "partial":
            ctx.notes.append(
                f"vendor '{wanted}' was not among the first {res.listed} of {res.total} vendors "
                "Zip returned, so its status is unknown"
            )

    # --- endpoints, kept separate so a path change is a one-line edit --------

    @staticmethod
    def _unwrap(doc: Any) -> list[dict[str, Any]]:
        """Zip returns {"list": [...], "size": n, "total": n}."""
        if isinstance(doc, dict):
            for key in ("list", "data", "results"):
                if isinstance(doc.get(key), list):
                    return doc[key]
            return [doc]
        return doc if isinstance(doc, list) else []

    @staticmethod
    def _total(doc: Any) -> int | None:
        if isinstance(doc, dict) and isinstance(doc.get("total"), int):
            return doc["total"]
        return None

    @staticmethod
    def _match(records: list[dict[str, Any]], needle: Any) -> dict[str, Any] | None:
        """Find a record by id or name.

        Zip's collection endpoints reject unknown query parameters with a 400
        rather than ignoring them, so there is no `?q=` to search with — the
        filtering happens here. Ids are tried first: real Zip calls refer to a
        vendor by id, and comparing an id to display names reports a real,
        approved vendor as unknown.
        """
        if not records:
            return None
        if not needle:
            return records[0]
        want = str(needle).strip().lower()
        for r in records:
            for field_name in _ID_FIELDS:
                value = r.get(field_name)
                if value not in (None, "") and str(value).strip().lower() == want:
                    return r
        for r in records:
            for field_name in _NAME_FIELDS:
                value = r.get(field_name)
                if value and str(value).strip().lower() == want:
                    return r
        for r in records:  # fall back to a partial match
            for field_name in ("name", "display_name"):
                value = r.get(field_name)
                if value and want in str(value).strip().lower():
                    return r
        return None

    async def _budget(self, budget: Any) -> dict[str, Any] | None:
        """Budget position.

        GET /budgets is not offered — the route allows only OPTIONS and PUT — so
        budget state has to come from elsewhere. Left here and failing soft so
        the rest of the context still assembles.
        """
        if not budget or not self._budgets_readable:
            return None
        try:
            return self._match(self._unwrap(await self._get(config.zip_budgets_path)), budget)
        except httpx.HTTPStatusError as err:
            if err.response.status_code in (404, 405):
                self._budgets_readable = False
                print("[agentgate] Zip has no readable budget endpoint over REST "
                      "(/budgets allows OPTIONS, PUT only); budget grounding is off. "
                      "Budget state is available through their MCP server instead.")
                return None
            raise

    async def _vendor(self, vendor: Any) -> VendorLookup | None:
        if not vendor:
            return None
        doc = await self._get(config.zip_vendors_path)
        records = self._unwrap(doc)
        total = self._total(doc)
        if not records:
            return VendorLookup(None, "empty", 0, total)
        record = self._match(records, vendor)
        if record is not None:
            return VendorLookup(record, "found", len(records), total)
        # Not in what we were given. Only "absent" if we were given everything;
        # a paginated first page cannot prove a vendor does not exist.
        if total is not None and total > len(records):
            return VendorLookup(None, "partial", len(records), total)
        return VendorLookup(None, "absent", len(records), total)

    async def _approvals(self, request_number: Any) -> list[dict[str, Any]] | None:
        """Approval steps on ONE request. /approvals searches approval nodes across
        every request, so without a request number the answer would be somebody
        else's approvals — never ask that. Returns None when there is no request to
        ask about, and [] when Zip has no steps for it."""
        if not request_number:
            return None
        return self._unwrap(
            await self._get(config.zip_approvals_path, params={"request_number": str(request_number)})
        )

    async def aclose(self) -> None:
        await self._client.aclose()


_client: ZipClient | None = None

# What /health reports. Grounding that is quietly off, or quietly failing, looks
# exactly like grounding that has nothing to add — so its state is surfaced.
_last: dict[str, Any] = {"error": None, "ok_at": None, "lookups": 0}


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
    _last.update(error=None, ok_at=None, lookups=0)


def zip_status() -> dict[str, Any]:
    """`off`, `on` or `degraded`, and why. Never includes the key."""
    if not zip_configured():
        return {"state": "off", "reason": "no ZIP_API_KEY (or ZIP_API_TOKEN) set"}
    base = config.zip_api_base
    if _last["error"]:
        return {"state": "degraded", "base": base, "reason": _last["error"], "lookups": _last["lookups"]}
    return {"state": "on", "base": base, "lookups": _last["lookups"]}


async def zip_context(tool_args: dict[str, Any]) -> ZipContext | None:
    """Zip facts for this action, or None when Zip is not configured."""
    client = zip_client()
    if client is None:
        return None
    _last["lookups"] += 1
    try:
        ctx = await client.context_for(tool_args)
    except Exception as err:  # noqa: BLE001 — Zip must never take the judge down
        print(f"[agentgate] Zip lookup failed, judging on policy alone: {err}")
        _last["error"] = str(err)[:120]
        return ZipContext(degraded=True, note=str(err)[:120])
    if ctx.degraded:
        _last["error"] = ctx.note
    else:
        _last.update(error=None, ok_at=time.time())
    return ctx
