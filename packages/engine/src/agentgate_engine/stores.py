"""Storage seams.

The engine only ever talks to these two protocols, so moving to Cloudflare
(Vectorize for vectors, D1 or Durable Objects for session state) means writing
one new class each — no change to the pipeline.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class VectorRecord:
    id: str
    vector: list[float]
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class VectorMatch:
    id: str
    score: float


class VectorStore(Protocol):
    async def upsert(self, records: list[VectorRecord]) -> None: ...
    async def query(self, vector: list[float], top_k: int) -> list[VectorMatch]: ...
    async def size(self) -> int: ...


@dataclass
class SessionState:
    """Per-session counters the Pattern Detector accumulates across actions."""

    session_id: str
    # One running total per cumulative policy, keyed by policy id. Generic on
    # purpose: what gets counted is declared by the policy, not by this code.
    counters: dict[str, float] = field(default_factory=dict)
    action_counts: dict[str, int] = field(default_factory=dict)
    last_actions: list[dict[str, Any]] = field(default_factory=list)
    # Trimmed history so the judge sees the session even when the caller passes none.
    recent_actions: list[dict[str, Any]] = field(default_factory=list)
    # Fingerprint -> risk score, for the consistency guardrail.
    score_history: list[dict[str, Any]] = field(default_factory=list)


class SessionStore(Protocol):
    async def get(self, session_id: str) -> SessionState: ...
    async def save(self, state: SessionState) -> None: ...
    async def reset(self) -> None: ...


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


class MemoryVectorStore:
    """Exhaustive cosine scan. Fine for ~20 policies; swap for Vectorize at scale."""

    def __init__(self) -> None:
        self._records: dict[str, VectorRecord] = {}

    async def upsert(self, records: list[VectorRecord]) -> None:
        for r in records:
            self._records[r.id] = r

    async def query(self, vector: list[float], top_k: int) -> list[VectorMatch]:
        scored = [VectorMatch(r.id, cosine(vector, r.vector)) for r in self._records.values()]
        scored.sort(key=lambda m: m.score, reverse=True)
        return scored[:top_k]

    async def size(self) -> int:
        return len(self._records)


class MemorySessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}

    async def get(self, session_id: str) -> SessionState:
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState(session_id=session_id)
        return self._sessions[session_id]

    async def save(self, state: SessionState) -> None:
        self._sessions[state.session_id] = state

    async def reset(self) -> None:
        self._sessions.clear()


_vectors: Any = MemoryVectorStore()
_sessions: Any = MemorySessionStore()


def configure_stores(vectors: Any = None, sessions: Any = None) -> None:
    """Swap point for Cloudflare. Call once at boot; nothing else changes."""
    global _vectors, _sessions
    if vectors is not None:
        _vectors = vectors
    if sessions is not None:
        _sessions = sessions


def vector_store() -> Any:
    return _vectors


def session_store() -> Any:
    return _sessions
