"""Runtime policy management.

AgentGate ships 21 policies as markdown files, but a customer's policy set is
theirs, not ours — and an enterprise will have far more than twenty. Files on
disk cannot be edited by an admin through a dashboard, do not survive a
container restart, and are not shared between replicas.

A policy created here is:
  1. validated (including any Accumulate/Limit clause),
  2. persisted to the policy store (D1 when configured, memory otherwise),
  3. embedded and upserted into the vector index,
  4. live for the very next evaluation — no restart, no redeploy.

The markdown files become a seed pack: what a fresh install starts with, not
the limit of what it can hold.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Protocol

from .limits import LimitSpecError, parse_limit_spec

POLICY_TABLE = """
CREATE TABLE IF NOT EXISTS agentgate_policies (
  id         TEXT PRIMARY KEY,
  markdown   TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  source     TEXT NOT NULL DEFAULT 'api',
  updated_at INTEGER NOT NULL
)
"""


class PolicyStoreBackend(Protocol):
    async def all(self) -> list[dict[str, Any]]: ...
    async def put(self, policy_id: str, markdown: str, enabled: bool, source: str) -> None: ...
    async def delete(self, policy_id: str) -> bool: ...


@dataclass
class MemoryPolicyBackend:
    """Default backend. Lost on restart, which is why D1 exists."""

    rows: dict[str, dict[str, Any]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.rows is None:
            self.rows = {}

    async def all(self) -> list[dict[str, Any]]:
        return list(self.rows.values())

    async def put(self, policy_id: str, markdown: str, enabled: bool, source: str) -> None:
        self.rows[policy_id] = {
            "id": policy_id, "markdown": markdown, "enabled": enabled, "source": source,
        }

    async def delete(self, policy_id: str) -> bool:
        return self.rows.pop(policy_id, None) is not None


class D1PolicyBackend:
    """Policies in Cloudflare D1, so they survive restarts and are shared."""

    def __init__(self, session_store: Any) -> None:
        # Reuses D1SessionStore's authenticated _sql helper rather than opening
        # a second client against the same database.
        self._d1 = session_store
        self._ready = False

    async def _ensure(self) -> None:
        if not self._ready:
            await self._d1._sql(POLICY_TABLE)
            self._ready = True

    async def all(self) -> list[dict[str, Any]]:
        await self._ensure()
        rows = await self._d1._sql(
            "SELECT id, markdown, enabled, source FROM agentgate_policies"
        )
        return [{**r, "enabled": bool(r["enabled"])} for r in rows]

    async def put(self, policy_id: str, markdown: str, enabled: bool, source: str) -> None:
        await self._ensure()
        await self._d1._sql(
            "INSERT OR REPLACE INTO agentgate_policies "
            "(id, markdown, enabled, source, updated_at) "
            "VALUES (?, ?, ?, ?, strftime('%s','now'))",
            [policy_id, markdown, 1 if enabled else 0, source],
        )

    async def delete(self, policy_id: str) -> bool:
        await self._ensure()
        await self._d1._sql("DELETE FROM agentgate_policies WHERE id = ?", [policy_id])
        return True


_backend: PolicyStoreBackend = MemoryPolicyBackend()


def configure_policy_backend(backend: PolicyStoreBackend) -> None:
    global _backend
    _backend = backend


def policy_backend() -> PolicyStoreBackend:
    return _backend


class PolicyValidationError(ValueError):
    pass


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:64]
    return slug or "policy"


def validate_markdown(markdown: str) -> dict[str, Any]:
    """Reject a policy that would silently do nothing, or nothing safe.

    A policy the judge cannot act on is worse than no policy: an operator adds
    it, sees it listed, and believes a control is on.
    """
    if not markdown.strip():
        raise PolicyValidationError("policy body is empty")

    title = re.search(r"^#\s+(.+)$", markdown, re.M)
    if not title:
        raise PolicyValidationError("policy must start with a '# Title' heading")

    body = re.sub(r"^#.+$", "", markdown, count=1, flags=re.M)
    body = re.sub(r"^(Severity|Applies to|Enforced by|Accumulate|Scope|Limit|"
                  r"When exceeded|Risk floor|Match):.+$", "", body, flags=re.M | re.I)
    if len(body.strip()) < 20:
        raise PolicyValidationError(
            "policy needs a body the judge can reason about, not just a title"
        )

    if not re.search(r"^Applies to:\s*\S", markdown, re.M | re.I):
        raise PolicyValidationError(
            "policy must declare 'Applies to:' with at least one category "
            "(data_access, external_comms, financial, system_modification, other)"
        )

    try:
        limit = parse_limit_spec(markdown)
    except LimitSpecError as err:
        raise PolicyValidationError(str(err)) from err

    return {"name": title.group(1).strip(), "declares_limit": limit is not None}


async def upsert_policy(
    markdown: str, *, policy_id: str | None = None, enabled: bool = True,
    source: str = "api",
) -> dict[str, Any]:
    """Validate, persist, re-embed, and make live. Raises on invalid input."""
    meta = validate_markdown(markdown)
    pid = policy_id or slugify(meta["name"])
    if not _ID_RE.match(pid):
        raise PolicyValidationError(
            f"policy id {pid!r} must be lowercase letters, digits and hyphens"
        )

    await _backend.put(pid, markdown, enabled, source)
    await reload_policies()
    return {"id": pid, "name": meta["name"], "enabled": enabled,
            "declaresLimit": meta["declares_limit"]}


async def delete_policy(policy_id: str) -> bool:
    removed = await _backend.delete(policy_id)
    await reload_policies()
    return removed


async def set_enabled(policy_id: str, enabled: bool) -> bool:
    rows = {r["id"]: r for r in await _backend.all()}
    row = rows.get(policy_id)
    if row is None:
        return False
    await _backend.put(policy_id, row["markdown"], enabled, row.get("source", "api"))
    await reload_policies()
    return True


async def reload_policies() -> int:
    """Rebuild the live corpus: the markdown seed pack plus everything stored.

    Stored policies win on an id collision, so a customer can override a shipped
    default by creating one with the same id.
    """
    from .policy_store import seed_pack, set_policies, warm_policy_index

    merged: dict[str, tuple[str, str]] = {
        f"{pid}.md": (f"{pid}.md", md) for pid, md in seed_pack().items()
    }
    for row in await _backend.all():
        if row["enabled"]:
            merged[f"{row['id']}.md"] = (f"{row['id']}.md", row["markdown"])
        else:
            merged.pop(f"{row['id']}.md", None)

    set_policies(list(merged.values()))
    await warm_policy_index(force=True)
    return len(merged)
