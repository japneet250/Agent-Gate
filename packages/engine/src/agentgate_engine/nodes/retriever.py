"""Node 2 — pull the policies that actually bear on this action."""

from __future__ import annotations

import json
from typing import Any

from ..enrich import enrich_query
from ..policy_store import retrieve_policies
from ..state import GraphState


def to_query(state: GraphState) -> str:
    """Turn a tool call into the query we search policies with, annotated with
    the kinds of sensitive data detected in its arguments."""
    action = state["action"]
    payload = json.dumps(action.tool_args or {}, default=str)
    base = (
        f'Category {state["category"]}. Tool "{action.tool_name}" '
        f"called with arguments: {payload}"
    )
    return enrich_query(base, f"{action.tool_name} {payload}")


async def retriever_node(state: GraphState) -> dict[str, Any]:
    policies = await retrieve_policies(
        to_query(state), category=state["category"], trace=state["trace"]
    )
    return {"policies": policies}
