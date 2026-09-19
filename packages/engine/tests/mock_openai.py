"""A scriptable stand-in for the OpenAI client.

Lets the offline suite test the pipeline's own behaviour — routing, guardrails,
patterns, fallbacks — without a key and without testing the model's judgement.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

_DIMS = 256


def fake_embed(text: str, dims: int = _DIMS) -> list[float]:
    """Deterministic bag-of-words embedding, so cosine similarity is genuinely lexical."""
    vector = [0.0] * dims
    for token in re.split(r"[^a-z0-9$]+", text.lower()):
        if len(token) < 3:
            continue
        h = 0
        for ch in token:
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        vector[h % dims] += 1.0
    return vector


def action_block(prompt: str) -> str:
    """The attempted-action section of the judge prompt, lowercased.

    The retrieved policies quote example SSNs and example SQL, so scanning the
    whole prompt would score every action off the policy text rather than the action.
    """
    start = prompt.find("## Attempted action")
    end = prompt.find("## Retrieved policies")
    chunk = prompt[start:end] if 0 <= start < end else prompt
    return chunk.lower()


def _default_classify(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    t = tool.lower()
    # Mirrors the real classifier's precedence: reads before money words.
    if re.match(r"^(lookup|get|read|list|search|fetch|check|query|view)", t):
        return {"category": "data_access", "confidence": 0.9}
    if re.search(r"(payment|purchase|refund|transfer|invoice|_order|spend)", t):
        return {"category": "financial", "confidence": 0.95}
    if re.search(r"(email|send|notify|webhook|message)", t):
        return {"category": "external_comms", "confidence": 0.95}
    if re.search(r"(run_command|exec|write_file|grant|deploy)", t):
        return {"category": "system_modification", "confidence": 0.95}
    return {"category": "other", "confidence": 0.6}


def _default_judge(prompt: str) -> dict[str, Any]:
    p = action_block(prompt)
    if re.search(r"\d{3}-\d{2}-\d{4}|drop table|rm -rf|delete from", p):
        return {
            "risk_score": 92,
            "reasoning": "Mock: destructive or PII payload detected.",
            "violated_policy": "",
        }
    if re.search(r"newpayee|unknown vendor", p):
        return {
            "risk_score": 55,
            "reasoning": "Mock: unverifiable financial action.",
            "violated_policy": "",
        }
    return {"risk_score": 8, "reasoning": "Mock: routine read within scope.", "violated_policy": ""}


@dataclass
class MockOpenAI:
    """Implements just enough of the AsyncOpenAI surface for the pipeline."""

    classify: Callable[[str, dict[str, Any]], dict[str, Any]] = _default_classify
    judge: Callable[[str], dict[str, Any]] = _default_judge
    # Raise from here to exercise the failure paths.
    on_call: Callable[[str], None] | None = None
    calls: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.chat = _Chat(self)
        self.embeddings = _Embeddings(self)

    def count(self, kind: str) -> int:
        return sum(1 for c in self.calls if c == kind)


class _Completions:
    def __init__(self, parent: MockOpenAI) -> None:
        self._p = parent

    async def create(self, **params: Any) -> Any:
        is_classifier = params["tools"][0]["function"]["name"] == "classify_action"
        kind = "classify" if is_classifier else "judge"
        self._p.calls.append(kind)
        if self._p.on_call:
            self._p.on_call(kind)

        user = next(m["content"] for m in params["messages"] if m["role"] == "user")
        if is_classifier:
            tool = re.search(r"tool:\s*(.+)", user)
            args = re.search(r"args:\s*(\{.*\})", user, re.S)
            payload = self._p.classify(
                tool.group(1).strip() if tool else "",
                json.loads(args.group(1)) if args else {},
            )
        else:
            payload = self._p.judge(user)

        return _Response(params["tools"][0]["function"]["name"], payload)


class _Chat:
    def __init__(self, parent: MockOpenAI) -> None:
        self.completions = _Completions(parent)


class _Embeddings:
    def __init__(self, parent: MockOpenAI) -> None:
        self._p = parent

    async def create(self, **params: Any) -> Any:
        self._p.calls.append("embed")
        if self._p.on_call:
            self._p.on_call("embed")
        inputs = params["input"]
        if isinstance(inputs, str):
            inputs = [inputs]
        return _EmbedResponse([_Embedding(fake_embed(t)) for t in inputs])


@dataclass
class _Embedding:
    embedding: list[float]


@dataclass
class _Usage:
    prompt_tokens: int = 100
    completion_tokens: int = 20


@dataclass
class _EmbedResponse:
    data: list[_Embedding]
    usage: _Usage = field(default_factory=lambda: _Usage(50, 0))


class _Function:
    def __init__(self, name: str, payload: Any) -> None:
        self.name = name
        self.arguments = json.dumps(payload)


class _ToolCall:
    def __init__(self, name: str, payload: Any) -> None:
        self.type = "function"
        self.function = _Function(name, payload)


class _Message:
    def __init__(self, name: str, payload: Any) -> None:
        self.tool_calls = [_ToolCall(name, payload)]


class _Choice:
    def __init__(self, name: str, payload: Any) -> None:
        self.message = _Message(name, payload)


class _Response:
    def __init__(self, name: str, payload: Any) -> None:
        self.choices = [_Choice(name, payload)]
        self.usage = _Usage()
