"""Node 1 — label the action so retrieval knows where to look."""

from __future__ import annotations

import json
import re
from typing import Any

from ..config import config
from ..llm import guarded_call, openai_client, usage_of
from ..state import GraphState

CATEGORIES = ["data_access", "external_comms", "financial", "system_modification", "other"]

SYSTEM = """You classify AI agent tool calls for a runtime security firewall.
Pick exactly one category:
- data_access: reading, querying, exporting, or listing stored data
- external_comms: sending anything outside the org (email, SMS, webhook, third-party API)
- financial: money movement — payments, purchase orders, refunds, transfers, budgets
- system_modification: shell commands, schema or infra changes, permissions, writing files
- other: anything else
Judge by what the call actually does, not by what it is named.
Also give confidence 0-1."""

TOOL = {
    "type": "function",
    "function": {
        "name": "classify_action",
        "description": "Return the category of the agent action.",
        "parameters": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": CATEGORIES},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["category", "confidence"],
            "additionalProperties": False,
        },
    },
}

_DESTRUCTIVE = re.compile(r"(drop\s+table|truncate|alter\s+table|delete\s+from|rm\s+-rf|mkfs|chmod)", re.I)
_READ = re.compile(r"^(lookup|get|read|list|search|fetch|find|describe|check|query|view|show)", re.I)
_MONEY = re.compile(r"(payment|purchase|refund|invoice|transfer|charge|payout|billing|_order|order_|spend|budget)", re.I)
_COMMS = re.compile(r"(email|sms|slack|webhook|notify|send|post_message|publish|message|dispatch)", re.I)
_SYSTEM = re.compile(r"(run_command|exec|shell|write_file|deploy|migrate|grant|revoke|iam|provision|delete|create|update|modify)", re.I)


def heuristic_category(tool_name: str, args: dict[str, Any] | None) -> str:
    """Deterministic guess, used as the fallback whenever the model is unavailable.

    Order matters: a destructive payload outranks the tool's name, and read verbs
    are checked before money words so `lookup_order` is a read, not a purchase.
    """
    blob = json.dumps(args or {}, default=str)

    # What the call carries beats what it is called.
    if _DESTRUCTIVE.search(blob):
        return "system_modification"
    if _READ.search(tool_name):
        return "data_access"
    if _MONEY.search(tool_name):
        return "financial"
    if _COMMS.search(tool_name):
        return "external_comms"
    if _SYSTEM.search(tool_name):
        return "system_modification"
    return "other"


async def classifier_node(state: GraphState) -> dict[str, Any]:
    action = state["action"]
    fallback = heuristic_category(action.tool_name, action.tool_args)

    if not config.has_openai():
        return {"category": fallback, "category_confidence": 0.4, "degraded": True}

    trace = state["trace"]
    gen = trace.generation(
        "classifier.llm", config.classifier_model, {"tool": action.tool_name, "args": action.tool_args}
    )

    try:
        res = await guarded_call(
            lambda: openai_client().chat.completions.create(
                model=config.classifier_model,
                temperature=0,
                messages=[
                    {"role": "system", "content": SYSTEM},
                    {
                        "role": "user",
                        "content": f"tool: {action.tool_name}\nargs: {json.dumps(action.tool_args, default=str)}",
                    },
                ],
                tools=[TOOL],
                tool_choice={"type": "function", "function": {"name": "classify_action"}},
            ),
            label="classifier",
            timeout_s=config.classifier_timeout_s,
        )

        calls = res.choices[0].message.tool_calls
        if not calls:
            raise ValueError("no tool call returned")

        parsed = json.loads(calls[0].function.arguments)
        category = parsed.get("category") if parsed.get("category") in CATEGORIES else fallback
        confidence = float(parsed.get("confidence", 0.5))

        gen.end({"category": category, "confidence": confidence}, usage_of(config.classifier_model, getattr(res, "usage", None)))
        return {"category": category, "category_confidence": confidence}

    except Exception as err:  # noqa: BLE001
        gen.end({"error": str(err), "fallback": fallback})
        print(f"[agentgate] classifier degraded to heuristic: {err}")
        return {"category": fallback, "category_confidence": 0.4, "degraded": True}
