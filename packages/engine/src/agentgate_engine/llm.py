"""OpenAI access with the production patterns: timeouts, one retry on transient
errors, a circuit breaker, and token/cost accounting."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TypeVar

from openai import AsyncOpenAI

from .config import config

T = TypeVar("T")

_client: Any | None = None


def openai_client() -> Any:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.openai_api_key, max_retries=0)
    return _client


def set_openai_client(client: Any | None) -> None:
    """Test seam: swap in a stub so the pipeline runs without a key."""
    global _client
    _client = client


class LlmError(RuntimeError):
    """Raised when a call gives up. Callers degrade; they never crash."""


class _CircuitBreaker:
    """After `threshold` consecutive failures, stop calling for `cooldown`.

    Without this, a provider outage costs the full timeout on every single
    action — the gateway would grind rather than fail fast to escalate.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.failures = 0
        self.opened_at = 0.0

    @property
    def is_open(self) -> bool:
        if self.failures < config.breaker_threshold:
            return False
        if time.monotonic() - self.opened_at > config.breaker_cooldown_s:
            self.failures = 0
            return False
        return True

    def record_success(self) -> None:
        self.failures = 0

    def record_failure(self) -> None:
        self.failures += 1
        if self.failures >= config.breaker_threshold:
            self.opened_at = time.monotonic()

    def reset(self) -> None:
        self.failures = 0
        self.opened_at = 0.0


_breakers: dict[str, _CircuitBreaker] = {}


def _breaker(name: str) -> _CircuitBreaker:
    if name not in _breakers:
        _breakers[name] = _CircuitBreaker(name)
    return _breakers[name]


def reset_breakers() -> None:
    for b in _breakers.values():
        b.reset()


def _is_retryable(err: BaseException) -> bool:
    status = getattr(err, "status_code", None) or getattr(err, "status", None)
    return status in (408, 429) or (isinstance(status, int) and status >= 500)


async def guarded_call(
    fn: Callable[[], Awaitable[T]],
    *,
    label: str,
    timeout_s: float,
    retries: int | None = None,
) -> T:
    """One LLM call with timeout, retry on transient errors, and circuit breaking."""
    breaker = _breaker(label)
    if breaker.is_open:
        raise LlmError(f"{label} circuit open — provider failing, skipping call")

    attempts = (config.retries if retries is None else retries) + 1
    last: BaseException | None = None

    for attempt in range(attempts):
        try:
            out = await asyncio.wait_for(fn(), timeout=timeout_s)
            breaker.record_success()
            return out
        except asyncio.TimeoutError as err:
            last = LlmError(f"{label} exceeded {int(timeout_s * 1000)}ms")
            break
        except BaseException as err:  # noqa: BLE001 — we degrade on anything
            last = err
            if attempt < attempts - 1 and _is_retryable(err):
                await asyncio.sleep(0.15 * (attempt + 1))
                continue
            break

    breaker.record_failure()
    raise LlmError(f"{label} failed: {last}")


# Per-1M-token prices, used for the cost figure on each LangFuse generation.
_PRICING = {
    "gpt-4o": (2.5, 10.0),
    "gpt-4o-mini": (0.15, 0.6),
    "text-embedding-3-small": (0.02, 0.0),
}


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0


def usage_of(model: str, usage: Any) -> Usage:
    price_in, price_out = _PRICING.get(model, (0.0, 0.0))
    prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion = int(getattr(usage, "completion_tokens", 0) or 0)
    return Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        cost_usd=(prompt * price_in + completion * price_out) / 1_000_000,
    )
