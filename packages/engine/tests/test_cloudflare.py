"""Cloudflare store tests against a mocked transport.

These verify the REST wiring — URLs, payload shapes, NDJSON encoding, response
parsing and the fallback behaviour — without needing a Cloudflare account. They
do NOT prove the live API accepts our requests; only a real run does that.
"""

from __future__ import annotations

import json

import httpx
import pytest

from agentgate_engine.cloudflare import D1SessionStore, VectorizeStore
from agentgate_engine.stores import MemorySessionStore, MemoryVectorStore, SessionState, VectorRecord


def _ok(result):
    return {"success": True, "errors": [], "messages": [], "result": result}


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestVectorizeStore:
    async def test_query_parses_matches_and_hits_the_right_url(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content)
            seen["auth"] = request.headers.get("authorization")
            return httpx.Response(200, json=_ok({"matches": [
                {"id": "pii-protection", "score": 0.91},
                {"id": "refund-limits", "score": 0.44},
            ]}))

        store = VectorizeStore("acct-1", "tok-1", "idx-1")
        store._client = transport(handler)

        matches = await store.query([0.1, 0.2, 0.3], 5)

        assert [m.id for m in matches] == ["pii-protection", "refund-limits"]
        assert matches[0].score == pytest.approx(0.91)
        assert seen["url"] == (
            "https://api.cloudflare.com/client/v4/accounts/acct-1"
            "/vectorize/v2/indexes/idx-1/query"
        )
        assert seen["body"]["topK"] == 5
        assert seen["auth"] == "Bearer tok-1"
        assert store.degraded is False

    async def test_upsert_sends_ndjson_one_vector_per_line(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/info"):
                return httpx.Response(200, json=_ok({"vectorCount": 0}))
            seen["content_type"] = request.headers.get("content-type")
            seen["lines"] = request.content.decode().strip().split("\n")
            return httpx.Response(200, json=_ok({"mutationId": "m1"}))

        store = VectorizeStore("a", "t", "i")
        store._client = transport(handler)

        await store.upsert([
            VectorRecord(id="p1", vector=[1.0, 2.0], metadata={"name": "One"}),
            VectorRecord(id="p2", vector=[3.0, 4.0], metadata={"name": "Two"}),
        ])

        assert seen["content_type"] == "application/x-ndjson"
        assert len(seen["lines"]) == 2, "NDJSON must be one vector per line"
        first = json.loads(seen["lines"][0])
        assert first["id"] == "p1" and first["values"] == [1.0, 2.0]

    async def test_query_falls_back_to_memory_when_cloudflare_is_down(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("cloudflare unreachable")

        fallback = MemoryVectorStore()
        await fallback.upsert([VectorRecord(id="local", vector=[1.0, 0.0])])

        store = VectorizeStore("a", "t", "i", fallback=fallback)
        store._client = transport(handler)

        matches = await store.query([1.0, 0.0], 3)

        assert [m.id for m in matches] == ["local"], "must degrade, not fail"
        assert store.degraded is True

    async def test_api_error_response_is_treated_as_failure(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"success": False, "errors": [{"message": "no such index"}]})

        store = VectorizeStore("a", "t", "i", fallback=MemoryVectorStore())
        store._client = transport(handler)

        assert await store.query([0.0], 3) == []
        assert store.degraded is True, "a success:false body is an error, not an empty result"


class TestD1SessionStore:
    async def test_round_trips_session_state_through_json(self):
        rows: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            sql = body["sql"].strip()
            if sql.startswith("CREATE TABLE"):
                return httpx.Response(200, json=_ok([{"results": []}]))
            if sql.startswith("SELECT"):
                sid = body["params"][0]
                found = [{"state": rows[sid]}] if sid in rows else []
                return httpx.Response(200, json=_ok([{"results": found}]))
            if sql.startswith("INSERT"):
                rows[body["params"][0]] = body["params"][1]
                return httpx.Response(200, json=_ok([{"results": []}]))
            return httpx.Response(200, json=_ok([{"results": []}]))

        store = D1SessionStore("a", "t", "db-1")
        store._client = transport(handler)

        fresh = await store.get("s-1")
        assert fresh.counters == {}

        fresh.counters["spending-limit-cumulative"] = 4800.0
        fresh.action_counts = {"approve_payment": 12}
        await store.save(fresh)

        again = await store.get("s-1")
        assert isinstance(again, SessionState)
        assert again.counters["spending-limit-cumulative"] == 4800.0
        assert again.action_counts == {"approve_payment": 12}
        assert store.degraded is False

    async def test_read_failure_degrades_to_memory(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("d1 down")

        store = D1SessionStore("a", "t", "db", fallback=MemorySessionStore())
        store._client = transport(handler)

        state = await store.get("s-9")
        assert state.session_id == "s-9", "must return a usable session, not raise"
        assert store.degraded is True
