"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def _load_dotenv() -> None:
    """Load `.env` from the nearest ancestor that has one.

    The repo keeps a single `.env` at its root, so the engine picks it up whether
    it is run from the repo root, from this package, or by uvicorn.
    """
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for candidate in [start, *start.parents][:6]:
            env = candidate / ".env"
            if env.is_file():
                load_dotenv(env)
                return


_load_dotenv()


def _num(name: str, fallback: float) -> float:
    raw = os.getenv(name, "")
    try:
        return float(raw) if raw else fallback
    except ValueError:
        return fallback


@dataclass
class Config:
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    classifier_model: str = field(
        default_factory=lambda: os.getenv("AGENTGATE_CLASSIFIER_MODEL", "gpt-4o-mini")
    )
    judge_model: str = field(
        default_factory=lambda: os.getenv("AGENTGATE_JUDGE_MODEL", "gpt-4o")
    )
    embed_model: str = field(
        default_factory=lambda: os.getenv("AGENTGATE_EMBED_MODEL", "text-embedding-3-small")
    )

    # Per-call latency budgets. Measured p95 for the judge is ~5.8s and max ~7.9s
    # under load, so these are set well clear of that: a timeout here turns a good
    # decision into a needless escalation, which is worse than waiting.
    classifier_timeout_s: float = field(default_factory=lambda: _num("AGENTGATE_CLASSIFIER_TIMEOUT_MS", 10000) / 1000)
    judge_timeout_s: float = field(default_factory=lambda: _num("AGENTGATE_JUDGE_TIMEOUT_MS", 25000) / 1000)
    embed_timeout_s: float = field(default_factory=lambda: _num("AGENTGATE_EMBED_TIMEOUT_MS", 15000) / 1000)
    # Whole-pipeline budget. Exceeding it is a guardrail note, not a crash.
    latency_budget_ms: float = field(default_factory=lambda: _num("AGENTGATE_LATENCY_BUDGET_MS", 40000))

    retries: int = field(default_factory=lambda: int(_num("AGENTGATE_RETRIES", 1)))
    breaker_threshold: int = field(default_factory=lambda: int(_num("AGENTGATE_BREAKER_THRESHOLD", 3)))
    breaker_cooldown_s: float = field(default_factory=lambda: _num("AGENTGATE_BREAKER_COOLDOWN_MS", 30000) / 1000)

    # Decision Gate thresholds.
    allow_below: int = field(default_factory=lambda: int(_num("AGENTGATE_ALLOW_BELOW", 30)))
    block_at: int = field(default_factory=lambda: int(_num("AGENTGATE_BLOCK_AT", 70)))

    # Pattern Detector thresholds.
    session_spend_limit: float = field(default_factory=lambda: _num("AGENTGATE_SESSION_SPEND_LIMIT", 5000))
    repeated_call_limit: int = field(default_factory=lambda: int(_num("AGENTGATE_REPEATED_CALL_LIMIT", 10)))
    data_access_limit: int = field(default_factory=lambda: int(_num("AGENTGATE_DATA_ACCESS_LIMIT", 25)))
    permission_request_limit: int = field(default_factory=lambda: int(_num("AGENTGATE_PERMISSION_LIMIT", 3)))

    # Consistency guardrail: max allowed score drift for a repeated identical action.
    consistency_drift_limit: float = field(default_factory=lambda: _num("AGENTGATE_CONSISTENCY_DRIFT", 25))

    # Hybrid retrieval blend.
    top_k: int = field(default_factory=lambda: int(_num("AGENTGATE_TOP_K", 5)))
    dense_weight: float = field(default_factory=lambda: _num("AGENTGATE_DENSE_WEIGHT", 0.7))
    sparse_weight: float = field(default_factory=lambda: _num("AGENTGATE_SPARSE_WEIGHT", 0.3))
    category_boost: float = field(default_factory=lambda: _num("AGENTGATE_CATEGORY_BOOST", 0.15))

    # Cloudflare. When account id + token + index/database are set, the engine
    # uses Vectorize for RAG and D1 for session state instead of memory.
    cloudflare_account_id: str = field(default_factory=lambda: os.getenv("CLOUDFLARE_ACCOUNT_ID", ""))
    cloudflare_api_token: str = field(default_factory=lambda: os.getenv("CLOUDFLARE_API_TOKEN", ""))
    vectorize_index: str = field(default_factory=lambda: os.getenv("VECTORIZE_INDEX", "agentgate-policies"))
    d1_database_id: str = field(default_factory=lambda: os.getenv("D1_DATABASE_ID", ""))

    langfuse_public_key: str = field(default_factory=lambda: os.getenv("LANGFUSE_PUBLIC_KEY", ""))
    langfuse_secret_key: str = field(default_factory=lambda: os.getenv("LANGFUSE_SECRET_KEY", ""))
    langfuse_base_url: str = field(
        default_factory=lambda: os.getenv("LANGFUSE_BASEURL", "https://cloud.langfuse.com")
    )

    def has_openai(self) -> bool:
        return bool(self.openai_api_key)


config = Config()
