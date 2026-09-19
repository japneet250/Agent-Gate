"""The LangGraph state graph.

    classifier → policy_retriever → risk_judge → decision_gate → pattern_detector
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

from langgraph.graph import END, START, StateGraph

from .nodes.classifier import classifier_node
from .nodes.decision_gate import decision_gate_node
from .nodes.judge import judge_node
from .nodes.pattern_detector import pattern_detector_node
from .nodes.retriever import retriever_node
from .state import GraphState

NodeFn = Callable[[GraphState], Awaitable[dict[str, Any]] | dict[str, Any]]


def traced(name: str, fn: NodeFn, describe: Callable[[GraphState], Any]) -> NodeFn:
    """Wrap a node so every execution becomes one LangFuse span with its latency."""

    async def wrapped(state: GraphState) -> dict[str, Any]:
        span = state["trace"].span(name, describe(state))
        started = time.perf_counter()
        try:
            out = fn(state)
            if hasattr(out, "__await__"):
                out = await out  # type: ignore[misc]
            span.end({"latency_ms": round((time.perf_counter() - started) * 1000)})
            return out  # type: ignore[return-value]
        except Exception as err:  # noqa: BLE001
            span.end(
                {
                    "error": str(err),
                    "latency_ms": round((time.perf_counter() - started) * 1000),
                }
            )
            raise

    return wrapped


def build_graph() -> Any:
    graph = StateGraph(GraphState)

    graph.add_node(
        "classifier",
        traced(
            "classifier.run",
            classifier_node,
            lambda s: {"tool": s["action"].tool_name, "args": s["action"].tool_args},
        ),
    )
    graph.add_node(
        "policy_retriever",
        traced("policy_retriever.search", retriever_node, lambda s: {"category": s["category"]}),
    )
    graph.add_node(
        "risk_judge",
        traced(
            "risk_judge.evaluate",
            judge_node,
            lambda s: {"category": s["category"], "policies": [p.name for p in s["policies"]]},
        ),
    )
    graph.add_node(
        "decision_gate",
        traced(
            "decision_gate.decide",
            decision_gate_node,
            lambda s: {"risk_score": s["verdict"].risk_score},
        ),
    )
    graph.add_node(
        "pattern_detector",
        traced(
            "pattern_detector.check",
            pattern_detector_node,
            lambda s: {"decision": s["decision"], "session_id": s["context"].session_id},
        ),
    )

    graph.add_edge(START, "classifier")
    graph.add_edge("classifier", "policy_retriever")
    graph.add_edge("policy_retriever", "risk_judge")
    graph.add_edge("risk_judge", "decision_gate")
    graph.add_edge("decision_gate", "pattern_detector")
    graph.add_edge("pattern_detector", END)

    return graph.compile()


_compiled: Any | None = None


def get_graph() -> Any:
    global _compiled
    if _compiled is None:
        _compiled = build_graph()
    return _compiled
