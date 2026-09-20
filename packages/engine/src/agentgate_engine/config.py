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

    # Loop detection is a structural control and stays in code: an agent
    # repeating one identical call is looping or injected, and that is true for
    # every customer.
    repeated_call_limit: int = field(default_factory=lambda: int(_num("AGENTGATE_REPEATED_CALL_LIMIT", 10)))

    # NOTE: cumulative spend, data-access volume and permission-escalation
    # thresholds are NOT configured here. They are declared by the policies that
    # enforce them (Accumulate:/Limit: in policies/*.md), so there is one source
    # of truth per limit. AGENTGATE_SESSION_SPEND_LIMIT, AGENTGATE_DATA_ACCESS_LIMIT
    # and AGENTGATE_PERMISSION_LIMIT were left behind by that change and did
    # nothing; setting one would have silently had no effect, which is worse
    # than the variable not existing.

    # Consistency guardrail: max allowed score drift for a repeated identical action.
    consistency_drift_limit: float = field(default_factory=lambda: _num("AGENTGATE_CONSISTENCY_DRIFT", 25))

    # Hybrid retrieval blend.
    top_k: int = field(default_factory=lambda: int(_num("AGENTGATE_TOP_K", 5)))
    dense_weight: float = field(default_factory=lambda: _num("AGENTGATE_DENSE_WEIGHT", 0.7))
    sparse_weight: float = field(default_factory=lambda: _num("AGENTGATE_SPARSE_WEIGHT", 0.3))
    category_boost: float = field(default_factory=lambda: _num("AGENTGATE_CATEGORY_BOOST", 0.15))

    # Shared secret. When set, /evaluate and the session endpoints require
    # `Authorization: Bearer <key>`. Empty means open — fine on localhost,
    # never fine on a public URL.
    api_key: str = field(default_factory=lambda: os.getenv("AGENTGATE_API_KEY", ""))

    # Zip — procurement. With a token set, financial actions are grounded in
    # real budget, vendor and approval-chain state instead of a policy's guess.
    # Zip's hackathon environment, from their setup docs. Not api.ziphq.com,
    # which is the production host and answers the same welcome banner.
    zip_api_base: str = field(default_factory=lambda: os.getenv("ZIP_API_BASE", "https://staging-api.zip.com"))
    zip_api_token: str = field(default_factory=lambda: os.getenv("ZIP_API_TOKEN", ""))
    # Endpoint reconnaissance against the live API (401 means the route exists
    # and only the key was rejected; 404 means it does not exist):
    #   /vendors      401  exists
    #   /requests     401  exists
    #   /approvals    401  exists   <- my earlier guess /approval-chains was 404
    #   /departments  401  exists
    #   /users        401  exists
    #   /budgets      405  exists but allows only OPTIONS, PUT — no GET, so
    #                      budget state is not readable by this path
    #   /purchase-orders, /me, /cost-centers   404
    zip_vendors_path: str = field(default_factory=lambda: os.getenv("ZIP_VENDORS_PATH", "/vendors"))
    zip_approvals_path: str = field(default_factory=lambda: os.getenv("ZIP_APPROVALS_PATH", "/approvals"))
    # /budgets rejects GET. Left configurable so it can be pointed at whatever
    # Zip's docs say once we can authenticate and read them.
    zip_budgets_path: str = field(default_factory=lambda: os.getenv("ZIP_BUDGETS_PATH", "/budgets"))
    zip_requests_path: str = field(default_factory=lambda: os.getenv("ZIP_REQUESTS_PATH", "/requests"))

    # Cloudflare. When account id + token + index/database are set, the engine
    # uses Vectorize for RAG and D1 for session state instead of memory.
    cloudflare_account_id: str = field(default_factory=lambda: os.getenv("CLOUDFLARE_ACCOUNT_ID", ""))
    cloudflare_api_token: str = field(default_factory=lambda: os.getenv("CLOUDFLARE_API_TOKEN", ""))
    vectorize_index: str = field(default_factory=lambda: os.getenv("VECTORIZE_INDEX", "agentgate-policies"))
    d1_database_id: str = field(default_factory=lambda: os.getenv("D1_DATABASE_ID", ""))

    langfuse_public_key: str = field(default_factory=lambda: os.getenv("LANGFUSE_PUBLIC_KEY", ""))
    langfuse_secret_key: str = field(default_factory=lambda: os.getenv("LANGFUSE_SECRET_KEY", ""))
    # Three spellings are in play across this repo and the LangFuse SDKs:
    # LANGFUSE_BASEURL (python sdk), LANGFUSE_BASE_URL (P3's typescript),
    # LANGFUSE_HOST (langfuse docs). Accept any, so one team member setting the
    # "wrong" one does not silently send traces to the wrong region and 401.
    langfuse_base_url: str = field(
        default_factory=lambda: (
            os.getenv("LANGFUSE_BASEURL")
            or os.getenv("LANGFUSE_BASE_URL")
            or os.getenv("LANGFUSE_HOST")
            or "https://cloud.langfuse.com"
        )
    )

    def has_openai(self) -> bool:
        return bool(self.openai_api_key)


config = Config()
