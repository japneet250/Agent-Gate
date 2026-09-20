"""Shared fixtures. Every test gets fresh stores, a fresh policy index, fresh
circuit breakers and a mock OpenAI client — no test can leak into another."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

import pytest
from agentgate_shared import AgentAction

from agentgate_engine.config import config
from agentgate_engine.llm import reset_breakers, set_openai_client
from agentgate_engine.policy_store import set_policies
from agentgate_engine.stores import MemorySessionStore, MemoryVectorStore, configure_stores

from .mock_openai import MockOpenAI


def make_action(
    tool_name: str, tool_args: dict[str, Any], session_id: str = "test-session"
) -> AgentAction:
    return AgentAction(
        id=str(uuid4()),
        agentId="test-agent",
        toolName=tool_name,
        toolArgs=tool_args,
        sessionId=session_id,
    )


@pytest.fixture(autouse=True)
def no_network():
    """No test may call a real third-party API.

    A real token in .env turns the offline suite into a live integration test
    that is slow, flaky and spends money — it took the suite from 1s to 12s
    before this existed.
    """
    saved = config.zip_api_token
    config.zip_api_token = ""
    yield
    config.zip_api_token = saved


@pytest.fixture
def action() -> Callable[..., AgentAction]:
    return make_action


@pytest.fixture
def harness():
    """Returns a factory: `mock = harness(judge=..., on_call=...)`."""
    created: list[MockOpenAI] = []

    def _build(**handlers: Any) -> MockOpenAI:
        config.openai_api_key = "test-key"
        # The offline suite must not reach the network. A real ZIP_API_TOKEN in
        # .env would otherwise send every financial evaluation to api.ziphq.com.
        config.zip_api_token = ""
        configure_stores(vectors=MemoryVectorStore(), sessions=MemorySessionStore())
        set_policies(None)
        reset_breakers()
        mock = MockOpenAI(**handlers)
        set_openai_client(mock)
        created.append(mock)
        return mock

    yield _build

    set_openai_client(None)
    set_policies(None)
    reset_breakers()
