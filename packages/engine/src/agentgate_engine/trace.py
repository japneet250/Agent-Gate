"""LangFuse tracing behind a thin adapter.

The adapter exists so the pipeline never imports LangFuse directly: tracing
no-ops without keys, and a LangFuse API change is contained to this file.

One trace per evaluation, one span per graph node, one generation per LLM call.
"""

from __future__ import annotations

from typing import Any, Protocol

from .config import config
from .llm import Usage

_client: Any | None = None

if config.langfuse_public_key and config.langfuse_secret_key:
    try:
        from langfuse import Langfuse

        _client = Langfuse(
            public_key=config.langfuse_public_key,
            secret_key=config.langfuse_secret_key,
            host=config.langfuse_base_url,
        )
    except Exception as err:  # noqa: BLE001 — tracing must never break evaluation
        print(f"[agentgate] LangFuse disabled: {err}")
        _client = None


def tracing_enabled() -> bool:
    return _client is not None


class Span(Protocol):
    def end(self, output: Any = None) -> None: ...


class Generation(Protocol):
    def end(self, output: Any = None, usage: Usage | None = None) -> None: ...


class _NoopSpan:
    def end(self, output: Any = None, usage: Usage | None = None) -> None:
        return None


_NOOP_SPAN = _NoopSpan()


class Trace(Protocol):
    def span(self, name: str, input: Any = None) -> Span: ...
    def generation(self, name: str, model: str, input: Any) -> Generation: ...
    def event(self, name: str, payload: Any) -> None: ...
    def end(self, output: Any = None) -> None: ...


class NoopTrace:
    def span(self, name: str, input: Any = None) -> Any:
        return _NOOP_SPAN

    def generation(self, name: str, model: str, input: Any) -> Any:
        return _NOOP_SPAN

    def event(self, name: str, payload: Any) -> None:
        return None

    def end(self, output: Any = None) -> None:
        return None


NOOP_TRACE = NoopTrace()


class _LangfuseSpan:
    def __init__(self, observation: Any) -> None:
        self._obs = observation

    def end(self, output: Any = None, usage: Usage | None = None) -> None:
        try:
            if usage is not None:
                self._obs.update(
                    output=output,
                    usage_details={
                        "input": usage.prompt_tokens,
                        "output": usage.completion_tokens,
                    },
                    cost_details={"total": usage.cost_usd},
                )
            else:
                self._obs.update(output=output)
            self._obs.end()
        except Exception:  # noqa: BLE001
            pass


class _LangfuseTrace:
    def __init__(self, root: Any) -> None:
        self._root = root

    def span(self, name: str, input: Any = None) -> Any:
        try:
            return _LangfuseSpan(self._root.start_observation(name=name, input=input))
        except Exception:  # noqa: BLE001
            return _NOOP_SPAN

    def generation(self, name: str, model: str, input: Any) -> Any:
        try:
            return _LangfuseSpan(
                self._root.start_observation(
                    name=name, as_type="generation", model=model, input=input
                )
            )
        except Exception:  # noqa: BLE001
            return _NOOP_SPAN

    def event(self, name: str, payload: Any) -> None:
        try:
            self._root.create_event(name=name, input=payload)
        except Exception:  # noqa: BLE001
            pass

    def end(self, output: Any = None) -> None:
        try:
            self._root.update(output=output)
            self._root.end()
        except Exception:  # noqa: BLE001
            pass


def start_trace(name: str, input: Any, session_id: str | None = None) -> Any:
    if _client is None:
        return NOOP_TRACE
    try:
        root = _client.start_observation(name=name, input=input)
        if session_id:
            try:
                root.update_trace(session_id=session_id)
            except Exception:  # noqa: BLE001
                pass
        return _LangfuseTrace(root)
    except Exception as err:  # noqa: BLE001
        print(f"[agentgate] trace start failed: {err}")
        return NOOP_TRACE


def flush_traces() -> None:
    """Call before process exit so buffered traces are delivered."""
    if _client is not None:
        try:
            _client.flush()
        except Exception:  # noqa: BLE001
            pass
