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

import time
from contextlib import asynccontextmanager
from typing import Any

from agentgate_shared import AgentAction, SessionContext
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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


@app.post("/evaluate")
@app.post("/judge/evaluate")
async def evaluate_endpoint(request: EvaluateRequest) -> dict[str, Any]:
    action, context = request.resolve()
    detail = await evaluate_detailed(action, context)

    _stats["evaluated"] += 1
    _stats[detail.result.decision] += 1

    return detail.to_wire()


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
        "storage": _storage,
        "stats": _stats,
    }


@app.get("/policies")
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
        }
        for p in load_policies()
    ]


@app.get("/sessions/{session_id}")
async def session_detail(session_id: str) -> dict[str, Any]:
    """Live cumulative state for a session — what the pattern detector can see."""
    s = await session_store().get(session_id)
    return {
        "sessionId": s.session_id,
        "totalSpend": s.total_spend,
        "spendLimit": config.session_spend_limit,
        "actionCounts": s.action_counts,
        "dataAccessCount": s.data_access_count,
        "permissionRequests": s.permission_requests,
        # camelCase on the wire, like every other field the dashboard reads.
        "recentActions": [
            {"toolName": a["tool_name"], "toolArgs": a["tool_args"], "at": a["at"]}
            for a in s.recent_actions
        ],
    }


@app.post("/sessions/reset")
async def sessions_reset() -> dict[str, str]:
    """Clear cumulative state. Use between demo runs."""
    await reset_sessions()
    return {"status": "reset"}
