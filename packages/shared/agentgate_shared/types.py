"""The contract between the gateway (Person 1), the engine (Person 2) and the
demo agents / evals (Person 3).

This is the Python mirror of ``packages/shared/types.ts``. The two files must
stay in step: the gateway serialises these shapes as JSON and the engine parses
them back. Change one, change the other, and tell the team.

Field names are camelCase on the wire because that is what the TypeScript
gateway sends. Python code uses snake_case attributes; pydantic aliases bridge
the two, so both ``AgentAction(toolName=...)`` and ``AgentAction(tool_name=...)``
work when parsing.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

Decision = Literal["allow", "block", "escalate"]

ActionCategory = Literal[
    "data_access",
    "external_comms",
    "financial",
    "system_modification",
    "other",
]


class _Wire(BaseModel):
    """Accepts camelCase from the wire and snake_case from Python; emits camelCase."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class AgentAction(_Wire):
    """One tool call an agent is attempting."""

    id: str = Field(default_factory=lambda: str(uuid4()))
    agent_id: str = Field(alias="agentId")
    tool_name: str = Field(alias="toolName")
    tool_args: dict[str, Any] = Field(default_factory=dict, alias="toolArgs")
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    session_id: str = Field(alias="sessionId")


class EvalResult(_Wire):
    """The engine's verdict on one action. This is what the gateway acts on."""

    risk_score: int = Field(alias="riskScore", ge=0, le=100)
    decision: Decision
    reasoning: str
    violated_policy: str | None = Field(default=None, alias="violatedPolicy")
    latency_ms: int = Field(alias="latencyMs", ge=0)


class Policy(_Wire):
    id: str
    name: str
    description: str
    type: Literal["rule", "llm"]
    pattern: str | None = None
    enabled: bool = True


class SessionContext(_Wire):
    """What the gateway may pass alongside a single action.

    Only ``session_id`` is required. If ``recent_actions`` is omitted the engine
    supplies the history it recorded itself.
    """

    session_id: str = Field(alias="sessionId")
    agent_id: str | None = Field(default=None, alias="agentId")
    recent_actions: list[AgentAction] | None = Field(default=None, alias="recentActions")
