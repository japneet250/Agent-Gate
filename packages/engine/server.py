"""AgentGate engine HTTP service.

    uvicorn server:app --port 8000

Person 1's TypeScript gateway calls this after its own rules have run:

    POST http://localhost:8000/evaluate
    { "action": { "agentId": …, "toolName": …, "toolArgs": {…}, "sessionId": … },
      "context": { "sessionId": …, "recentActions": [...] } }

`/judge/evaluate` is an alias for the same handler, for when it helps to tell
the gateway's own /evaluate apart from the engine's in logs.
"""

from __future__ import annotations

import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from agentgate_shared import AgentAction, SessionContext
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field

from agentgate_engine import (
    cloudflare_configured,
    configure_cloudflare_stores,
    evaluate_detailed,
    flush_traces,
    is_indexed,
    load_policies,
    reset_sessions,
    session_store,
    tracing_enabled,
    warmup,
)
from agentgate_engine.config import config

_started_at = time.time()
_stats = {"evaluated": 0, "allow": 0, "block": 0, "escalate": 0}


_storage = {"vectors": "memory", "sessions": "memory"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _storage
    # Point at Cloudflare when credentials are present; falls back silently
    # to in-memory and says so in /health if it cannot reach them.
    _storage = await configure_cloudflare_stores()
    print(f"[agentgate] storage — vectors: {_storage['vectors']}, sessions: {_storage['sessions']}")
    indexed = await warmup()
    print(
        f"[agentgate] engine ready — {len(load_policies())} policies, "
        f"{'hybrid retrieval' if indexed else 'KEYWORD-ONLY retrieval (no embeddings)'}, "
        f"tracing {'on' if tracing_enabled() else 'off'}"
    )
    yield
    flush_traces()


app = FastAPI(
    title="AgentGate Engine",
    description="The LLM-as-judge slow path. Returns a judgement; enforces nothing.",
    version="0.1.0",
    lifespan=lifespan,
)

# The dashboard and demo agents call this from elsewhere; it is a local hackathon
# service with no secrets of its own in its responses.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_key(authorization: str | None = Header(default=None)) -> None:
    """Shared-secret auth.

    No key configured means the engine is open, which is correct for localhost
    and wrong for anything reachable from the internet — an open endpoint lets
    anyone spend our OpenAI credit. Set AGENTGATE_API_KEY before tunnelling or
    deploying.
    """
    if not config.api_key:
        return
    expected = f"Bearer {config.api_key}"
    # compare_digest avoids leaking the key through response timing
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="missing or invalid API key")


class EvaluateRequest(BaseModel):
    """Accepts either {action, context} or a bare action, so a quick curl works."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    action: AgentAction | None = None
    context: SessionContext | None = None

    # Bare-action convenience fields.
    agent_id: str | None = Field(default=None, alias="agentId")
    tool_name: str | None = Field(default=None, alias="toolName")
    tool_args: dict[str, Any] | None = Field(default=None, alias="toolArgs")
    session_id: str | None = Field(default=None, alias="sessionId")

    def resolve(self) -> tuple[AgentAction, SessionContext | None]:
        if self.action is not None:
            return self.action, self.context
        return (
            AgentAction(
                agentId=self.agent_id or "unknown-agent",
                toolName=self.tool_name or "unknown_tool",
                toolArgs=self.tool_args or {},
                sessionId=self.session_id or "default-session",
            ),
            self.context,
        )


@app.post("/evaluate", dependencies=[Depends(require_key)])
@app.post("/judge/evaluate", dependencies=[Depends(require_key)])
async def evaluate_endpoint(request: EvaluateRequest) -> dict[str, Any]:
    action, context = request.resolve()
    detail = await evaluate_detailed(action, context)

    _stats["evaluated"] += 1
    _stats[detail.result.decision] += 1

    return detail.to_wire()


STATIC_DIR = Path(__file__).resolve().parent / "static"


@app.get("/dashboard", include_in_schema=False)
async def dashboard() -> FileResponse:
    """A local console for driving the engine by hand.

    Served from the engine so it is same-origin: no CORS, no mixed content when
    the engine is tunnelled over HTTPS, and no copy of the API key on disk.
    """
    # No-store: the console is edited during development and a cached copy
    # looks like a broken build.
    return FileResponse(
        STATIC_DIR / "dashboard.html",
        headers={"Cache-Control": "no-store, must-revalidate"},
    )


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/dashboard")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "uptimeSeconds": round(time.time() - _started_at),
        "policies": len(load_policies()),
        "retrieval": "hybrid" if is_indexed() else "keyword-only",
        "judgeModel": config.judge_model,
        "classifierModel": config.classifier_model,
        "tracing": tracing_enabled(),
        "openaiConfigured": config.has_openai(),
        "cloudflareConfigured": cloudflare_configured(),
        "authRequired": bool(config.api_key),
        "storage": _storage,
        "stats": _stats,
    }


@app.get("/policies", dependencies=[Depends(require_key)])
async def policies() -> list[dict[str, Any]]:
    """The policy store, for the dashboard's policy editor."""
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "severity": p.severity,
            "appliesTo": p.applies_to,
            "enforcedBy": p.enforced_by,
            "enabled": p.enabled,
            "limit": (
                {
                    "accumulate": p.limit.accumulate,
                    "limit": p.limit.limit,
                    "unit": p.limit.unit,
                    "scope": p.limit.scope,
                    "whenExceeded": p.limit.when_exceeded,
                    "match": p.limit.match,
                }
                if p.limit
                else None
            ),
        }
        for p in load_policies()
    ]


@app.post("/policies/reload", dependencies=[Depends(require_key)])
async def policies_reload() -> dict[str, Any]:
    """Re-read the policy directory and re-embed, without dropping session state.

    Policies are the product's configuration, so changing one should not need a
    restart — an operator edits a markdown file and the control is live. Session
    counters survive, so a limit can be adjusted mid-session.
    """
    from agentgate_engine.policy_store import set_policies

    set_policies(None)
    indexed = await warmup()
    loaded = load_policies()
    return {
        "status": "reloaded",
        "policies": len(loaded),
        "retrieval": "hybrid" if indexed else "keyword-only",
        "cumulativeLimits": [
            {
                "policy": p.name,
                "accumulate": p.limit.accumulate,
                "limit": p.limit.format_total(p.limit.limit),
                "whenExceeded": p.limit.when_exceeded,
            }
            for p in loaded
            if p.limit is not None
        ],
    }


@app.get("/sessions/{session_id}", dependencies=[Depends(require_key)])
async def session_detail(session_id: str) -> dict[str, Any]:
    """Live cumulative state for a session — what the pattern detector can see."""
    s = await session_store().get(session_id)
    return {
        "sessionId": s.session_id,
        # One running total per cumulative policy; what is counted is declared
        # by the policies, not fixed by this endpoint.
        "counters": s.counters,
        "actionCounts": s.action_counts,
        # camelCase on the wire, like every other field the dashboard reads.
        "recentActions": [
            {"toolName": a["tool_name"], "toolArgs": a["tool_args"], "at": a["at"]}
            for a in s.recent_actions
        ],
    }


@app.post("/sessions/reset", dependencies=[Depends(require_key)])
async def sessions_reset() -> dict[str, str]:
    """Clear cumulative state. Use between demo runs."""
    await reset_sessions()
    return {"status": "reset"}
