"""Cloudflare-backed implementations of the storage seams.

The engine is Python, so it cannot run on Workers — but Vectorize and D1 both
have REST APIs, so the engine can still use them over HTTPS. These classes
implement the same `VectorStore` and `SessionStore` protocols as the in-memory
ones, so `configure_stores()` is the only line that changes.

Both fail *soft*: if Cloudflare is unreachable or returns an error, they fall
back to the in-memory store rather than taking the pipeline down. A firewall
that cannot reach its vector database should still judge, using keyword
retrieval, rather than stop judging.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Any

import httpx

from .config import config
from .stores import (
    MemorySessionStore,
    MemoryVectorStore,
    SessionState,
    VectorMatch,
    VectorRecord,
)

API_ROOT = "https://api.cloudflare.com/client/v4"

# text-embedding-3-small. Change together with AGENTGATE_EMBED_MODEL.
EMBED_DIMENSIONS = 1536


class CloudflareError(RuntimeError):
    pass


def _headers(token: str) -> dict[str, str]:
    """Always built from the instance's own token.

    Reading the global config here instead would silently ignore credentials
    passed to a constructor and send an empty bearer token.
    """
    if not token:
        raise CloudflareError("no Cloudflare API token configured")
    return {"Authorization": f"Bearer {token}"}


def _check(payload: dict[str, Any], what: str) -> dict[str, Any]:
    if not payload.get("success", False):
        errors = payload.get("errors") or payload.get("messages") or payload
        raise CloudflareError(f"{what} failed: {errors}")
    return payload.get("result") or {}


class VectorizeStore:
    """Cloudflare Vectorize over the v2 REST API.

    Semantic policy matching for the RAG pipeline — the piece the Cloudflare
    prize names explicitly.
    """

    def __init__(
        self,
        account_id: str | None = None,
        api_token: str | None = None,
        index_name: str | None = None,
        *,
        fallback: Any | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.account_id = account_id or config.cloudflare_account_id
        self.index_name = index_name or config.vectorize_index
        self._token = api_token or config.cloudflare_api_token
        self._base = f"{API_ROOT}/accounts/{self.account_id}/vectorize/v2/indexes/{self.index_name}"
        self._client = httpx.AsyncClient(timeout=timeout)
        # Used when Cloudflare is unreachable, so retrieval degrades instead of dying.
        self._fallback = fallback if fallback is not None else MemoryVectorStore()
        self._degraded = False

    @property
    def degraded(self) -> bool:
        return self._degraded

    async def ensure_index(self) -> None:
        """Create the index if it does not exist. Safe to call repeatedly."""
        info = await self._client.get(f"{self._base}/info", headers=_headers(self._token))
        if info.status_code == 200 and info.json().get("success"):
            return

        created = await self._client.post(
            f"{API_ROOT}/accounts/{self.account_id}/vectorize/v2/indexes",
            headers=_headers(self._token),
            json={
                "name": self.index_name,
                "description": "AgentGate policy vectors",
                "config": {"dimensions": EMBED_DIMENSIONS, "metric": "cosine"},
            },
        )
        body = created.json()
        # A concurrent create is fine; anything else is not.
        if not body.get("success") and "already exists" not in json.dumps(body).lower():
            _check(body, "vectorize create index")

    async def upsert(self, records: list[VectorRecord]) -> None:
        if not records:
            return
        try:
            await self.ensure_index()
            # v2 upsert takes NDJSON, one vector per line.
            ndjson = "\n".join(
                json.dumps({"id": r.id, "values": r.vector, "metadata": r.metadata or {}})
                for r in records
            )
            res = await self._client.post(
                f"{self._base}/upsert",
                headers={**_headers(self._token), "Content-Type": "application/x-ndjson"},
                content=ndjson.encode("utf-8"),
            )
            _check(res.json(), "vectorize upsert")
            self._degraded = False
            # Mirror locally so a later outage still has vectors to search.
            await self._fallback.upsert(records)
        except Exception as err:  # noqa: BLE001
            self._degraded = True
            print(f"[agentgate] Vectorize upsert failed, using in-memory vectors: {err}")
            await self._fallback.upsert(records)

    async def query(self, vector: list[float], top_k: int) -> list[VectorMatch]:
        try:
            res = await self._client.post(
                f"{self._base}/query",
                headers=_headers(self._token),
                json={"vector": vector, "topK": top_k, "returnMetadata": "none"},
            )
            result = _check(res.json(), "vectorize query")
            self._degraded = False
            matches = [
                VectorMatch(id=m["id"], score=float(m["score"]))
                for m in result.get("matches", [])
            ]
            if matches:
                return matches

            # Vectorize is eventually consistent: for a few seconds after an
            # upsert a query legitimately returns nothing while the mutation is
            # still being applied. We mirror every upsert locally precisely so
            # that window does not silently drop us to keyword-only retrieval.
            if await self._fallback.size() > 0:
                print("[agentgate] Vectorize returned no matches (mutation still settling); "
                      "serving this query from the local mirror")
                return await self._fallback.query(vector, top_k)
            return []
        except Exception as err:  # noqa: BLE001
            self._degraded = True
            print(f"[agentgate] Vectorize query failed, falling back to in-memory: {err}")
            return await self._fallback.query(vector, top_k)

    async def size(self) -> int:
        """Vectors reported by the index.

        NOTE: Cloudflare's info endpoint lags badly — it returns 0 for a long
        while after vectors are already queryable. Do not use this to decide
        whether the index is populated; run a query instead.
        """
        try:
            res = await self._client.get(f"{self._base}/info", headers=_headers(self._token))
            return int(_check(res.json(), "vectorize info").get("vectorCount", 0))
        except Exception:  # noqa: BLE001
            return await self._fallback.size()

    async def is_queryable(self, probe: list[float], attempts: int = 8, delay: float = 4.0) -> bool:
        """Poll until the index actually answers a query.

        The honest readiness check, since `size()` cannot be trusted.
        """
        for _ in range(attempts):
            try:
                res = await self._client.post(
                    f"{self._base}/query",
                    headers=_headers(self._token),
                    json={"vector": probe, "topK": 1, "returnMetadata": "none"},
                )
                if (_check(res.json(), "vectorize query").get("matches") or []):
                    return True
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(delay)
        return False

    async def aclose(self) -> None:
        await self._client.aclose()


D1_SCHEMA = """
CREATE TABLE IF NOT EXISTS agentgate_sessions (
  session_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
"""


class D1SessionStore:
    """Cumulative session state in Cloudflare D1, over the REST API.

    State is stored as one JSON blob per session. That is the right shape here:
    the pattern detector reads the whole session or none of it, and D1 round
    trips cost more than the serialisation does.
    """

    def __init__(
        self,
        account_id: str | None = None,
        api_token: str | None = None,
        database_id: str | None = None,
        *,
        fallback: Any | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.account_id = account_id or config.cloudflare_account_id
        self.database_id = database_id or config.d1_database_id
        self._token = api_token or config.cloudflare_api_token
        self._base = f"{API_ROOT}/accounts/{self.account_id}/d1/database/{self.database_id}"
        self._client = httpx.AsyncClient(timeout=timeout)
        self._fallback = fallback if fallback is not None else MemorySessionStore()
        self._ready = False
        self._degraded = False

    @property
    def degraded(self) -> bool:
        return self._degraded

    async def _sql(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        res = await self._client.post(
            f"{self._base}/query",
            headers=_headers(self._token),
            json={"sql": sql, "params": params or []},
        )
        body = res.json()
        if not body.get("success", False):
            raise CloudflareError(f"d1 query failed: {body.get('errors')}")
        results = body.get("result") or []
        return results[0].get("results", []) if results else []

    async def ensure_schema(self) -> None:
        if self._ready:
            return
        await self._sql(D1_SCHEMA)
        self._ready = True

    async def get(self, session_id: str) -> SessionState:
        try:
            await self.ensure_schema()
            rows = await self._sql(
                "SELECT state FROM agentgate_sessions WHERE session_id = ?", [session_id]
            )
            self._degraded = False
            if not rows:
                return SessionState(session_id=session_id)
            return SessionState(**json.loads(rows[0]["state"]))
        except Exception as err:  # noqa: BLE001
            self._degraded = True
            print(f"[agentgate] D1 read failed, using in-memory session: {err}")
            return await self._fallback.get(session_id)

    async def save(self, state: SessionState) -> None:
        try:
            await self.ensure_schema()
            await self._sql(
                "INSERT OR REPLACE INTO agentgate_sessions (session_id, state, updated_at) "
                "VALUES (?, ?, strftime('%s','now'))",
                [state.session_id, json.dumps(asdict(state))],
            )
            self._degraded = False
        except Exception as err:  # noqa: BLE001
            self._degraded = True
            print(f"[agentgate] D1 write failed, using in-memory session: {err}")
            await self._fallback.save(state)

    async def reset(self) -> None:
        try:
            await self.ensure_schema()
            await self._sql("DELETE FROM agentgate_sessions")
        except Exception as err:  # noqa: BLE001
            print(f"[agentgate] D1 reset failed: {err}")
        await self._fallback.reset()

    async def aclose(self) -> None:
        await self._client.aclose()


def cloudflare_configured() -> bool:
    return bool(config.cloudflare_account_id and config.cloudflare_api_token)


async def configure_cloudflare_stores(*, vectors: bool = True, sessions: bool = True) -> dict[str, str]:
    """Point the engine at Cloudflare if credentials are present.

    Returns what each store ended up as, so `/health` can report it honestly
    rather than claiming Cloudflare when it silently fell back.
    """
    from .stores import configure_stores

    status = {"vectors": "memory", "sessions": "memory"}
    if not cloudflare_configured():
        return status

    kwargs: dict[str, Any] = {}

    if vectors and config.vectorize_index:
        store = VectorizeStore()
        try:
            await store.ensure_index()
            kwargs["vectors"] = store
            status["vectors"] = f"vectorize:{store.index_name}"
        except Exception as err:  # noqa: BLE001
            print(f"[agentgate] Vectorize unavailable, staying in-memory: {err}")

    if sessions and config.d1_database_id:
        store = D1SessionStore()
        try:
            await store.ensure_schema()
            kwargs["sessions"] = store
            status["sessions"] = f"d1:{store.database_id[:8]}…"
        except Exception as err:  # noqa: BLE001
            print(f"[agentgate] D1 unavailable, staying in-memory: {err}")

    if kwargs:
        configure_stores(**kwargs)
    return status
