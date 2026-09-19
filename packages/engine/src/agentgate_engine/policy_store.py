"""The policy knowledge base and hybrid retrieval over it."""

from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path
from typing import Any

from .config import config
from .llm import Usage, guarded_call, openai_client, usage_of
from .state import RetrievedPolicy
from .stores import VectorRecord, vector_store
from .trace import NOOP_TRACE

POLICY_DIR = Path(__file__).resolve().parent / "policies"

_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "be", "may",
    "not", "that", "this", "with", "as", "by", "from", "it", "its", "any", "all", "must",
    "agent", "agents", "action", "called", "arguments", "tool", "category",
}

_store: list[RetrievedPolicy] | None = None
_tokens: dict[str, set[str]] = {}
_indexed = False


def _tokenize(text: str) -> set[str]:
    return {
        t for t in re.split(r"[^a-z0-9$]+", text.lower()) if len(t) > 2 and t not in _STOP
    }


def _parse_policy(filename: str, raw: str) -> RetrievedPolicy:
    """Parse `# Title`, body, `Severity:`, `Applies to:` and `Enforced by:`."""
    policy_id = filename[:-3] if filename.endswith(".md") else filename
    name_match = re.search(r"^#\s+(.+)$", raw, re.M)
    name = name_match.group(1).strip() if name_match else policy_id

    sev = re.search(r"^Severity:\s*(.+)$", raw, re.M | re.I)
    severity = sev.group(1).strip().lower() if sev else "medium"

    applies = re.search(r"^Applies to:\s*(.+)$", raw, re.M | re.I)
    applies_to = [s.strip() for s in applies.group(1).split(",")] if applies else []

    enforced_by = (
        "pattern_detector"
        if re.search(r"^Enforced by:\s*pattern_detector\s*$", raw, re.M | re.I)
        else "judge"
    )

    description = raw
    for pattern in (r"^#.+$", r"^Severity:.+$", r"^Applies to:.+$", r"^Enforced by:.+$"):
        description = re.sub(pattern, "", description, count=1, flags=re.M | re.I)

    return RetrievedPolicy(
        id=policy_id,
        name=name,
        description=description.strip(),
        text=raw.strip(),
        severity=severity,
        applies_to=applies_to,
        enforced_by=enforced_by,
    )


def load_policies() -> list[RetrievedPolicy]:
    global _store
    if _store is None:
        _store = [
            _parse_policy(p.name, p.read_text(encoding="utf-8"))
            for p in sorted(POLICY_DIR.glob("*.md"))
        ]
        _tokens.clear()
        for p in _store:
            _tokens[p.id] = _tokenize(f"{p.name} {p.description}")
    return _store


def set_policies(raw: list[tuple[str, str]] | None) -> None:
    """Test seam: replace the policy set without touching disk."""
    global _store, _indexed
    _indexed = False
    _tokens.clear()
    if raw is None:
        _store = None
        return
    _store = [_parse_policy(name, content) for name, content in raw]
    for p in _store:
        _tokens[p.id] = _tokenize(f"{p.name} {p.description}")


async def _embed(texts: list[str], trace: Any, label: str) -> tuple[list[list[float]], Usage]:
    gen = trace.generation(label, config.embed_model, {"count": len(texts)})
    res = await guarded_call(
        lambda: openai_client().embeddings.create(model=config.embed_model, input=texts),
        label="embeddings",
        timeout_s=config.embed_timeout_s,
    )
    usage = usage_of(config.embed_model, getattr(res, "usage", None))
    vectors = [d.embedding for d in res.data]
    gen.end({"dimensions": len(vectors[0]) if vectors else 0}, usage)
    return vectors, usage


async def warm_policy_index(trace: Any = NOOP_TRACE) -> bool:
    """Embed every policy once into the configured vector store.

    Cheap (19 short docs) and it keeps the hot path down to a single query
    embedding. Safe to call repeatedly.
    """
    global _indexed
    policies = load_policies()
    if _indexed or not config.has_openai():
        return _indexed
    try:
        vectors, _ = await _embed([p.text for p in policies], trace, "policy_index.embed")
        await vector_store().upsert(
            [
                VectorRecord(id=p.id, vector=v, metadata={"name": p.name})
                for p, v in zip(policies, vectors)
            ]
        )
        _indexed = True
    except Exception as err:  # noqa: BLE001 — keyword-only retrieval still works
        print(f"[agentgate] policy embedding failed, keyword-only retrieval: {err}")
    return _indexed


def is_indexed() -> bool:
    return _indexed


def _keyword_score(query_tokens: set[str], policy_id: str) -> float:
    """Keyword overlap in [0,1] — our stand-in for BM25 in the hybrid blend."""
    if not query_tokens:
        return 0.0
    hits = len(query_tokens & _tokens.get(policy_id, set()))
    return hits / len(query_tokens)


async def retrieve_policies(
    query: str,
    *,
    category: str | None = None,
    top_k: int | None = None,
    trace: Any = NOOP_TRACE,
) -> list[RetrievedPolicy]:
    """Hybrid retrieval: dense similarity + keyword overlap + a category boost.

    Degrades to keyword-only when embeddings are unavailable.
    """
    policies = [p for p in load_policies() if p.enabled]
    k = top_k if top_k is not None else config.top_k
    query_tokens = _tokenize(query)

    dense: dict[str, float] = {}
    if config.has_openai():
        await warm_policy_index(trace)
        if _indexed:
            try:
                vectors, _ = await _embed([query], trace, "policy_retriever.embed_query")
                # Score every policy, not just top-k, so sparse can still promote one.
                for match in await vector_store().query(vectors[0], len(policies)):
                    dense[match.id] = match.score
            except Exception as err:  # noqa: BLE001
                print(f"[agentgate] query embedding failed, keyword-only: {err}")

    use_dense = bool(dense)
    scored: list[RetrievedPolicy] = []
    for p in policies:
        d = dense.get(p.id, 0.0)
        s = _keyword_score(query_tokens, p.id)
        boost = config.category_boost if category and category in p.applies_to else 0.0
        score = (
            config.dense_weight * d + config.sparse_weight * s + boost if use_dense else s + boost
        )
        scored.append(replace(p, score=score, dense_score=d, sparse_score=s))

    scored.sort(key=lambda p: p.score, reverse=True)
    return scored[:k]


def policy_exists(name_or_id: str) -> bool:
    """Guardrail helper: the judge may only cite policies that actually exist."""
    needle = name_or_id.strip().lower()
    return any(p.id.lower() == needle or p.name.lower() == needle for p in load_policies())
