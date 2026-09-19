"""Policy-defined cumulative limits.

AgentGate is a firewall for any enterprise, so the things it counts cannot be
baked into Python. A bank cares about spend; a hospital cares about how many
patient records an agent touched; a SaaS company cares about rows exported.
Previously the detector hardcoded four dimensions and money was a special case.

Now a policy declares its own rule:

    Enforced by: pattern_detector
    Accumulate: sum(toolArgs.amount)
    Scope: session
    Limit: 5000
    When exceeded: escalate
    Risk floor: 75

and the detector is a generic accumulator over whatever policies declare one.

Deliberately not a query language. Two accumulator forms cover the real cases
and can be read at a glance by whoever writes the policy:

    count()                    one per matching action
    sum(toolArgs.<field>)      add a numeric field out of the tool arguments

`Applies to:` decides which action categories a limit sees, so a limit scoped to
`data_access` never counts a payment. An optional `Match:` regex narrows further
by tool name, for rules that are about a family of tools rather than a whole
category — "permission grants", not "all system modification".
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# Keys that plausibly hold a currency amount, used when a policy says
# `sum(toolArgs.amount)` but the caller spelled the field differently.
_AMOUNT_ALIASES = ("amount", "total", "price", "value", "cost", "sum")

_COUNT_RE = re.compile(r"^count\(\s*\)$", re.I)
_SUM_RE = re.compile(r"^sum\(\s*toolArgs\.([A-Za-z_][A-Za-z0-9_]*)\s*\)$", re.I)


class LimitSpecError(ValueError):
    """A policy declared a cumulative rule the detector cannot parse."""


@dataclass
class LimitSpec:
    """The machine-readable half of a cumulative policy."""

    accumulate: str
    limit: float
    scope: str = "session"
    when_exceeded: str = "escalate"
    risk_floor: float = 70.0
    unit: str = ""
    # Optional regex on the tool name. None means every tool in the categories
    # named by `Applies to:`.
    match: str | None = None

    def applies_to_tool(self, tool_name: str) -> bool:
        if not self.match:
            return True
        return re.search(self.match, tool_name, re.I) is not None

    @property
    def is_count(self) -> bool:
        return bool(_COUNT_RE.match(self.accumulate))

    @property
    def sum_field(self) -> str | None:
        m = _SUM_RE.match(self.accumulate)
        return m.group(1) if m else None

    def validate(self) -> None:
        if not (self.is_count or self.sum_field):
            raise LimitSpecError(
                f"Accumulate: {self.accumulate!r} is not supported. "
                "Use count() or sum(toolArgs.<field>)."
            )
        if self.scope != "session":
            raise LimitSpecError(
                f"Scope: {self.scope!r} is not implemented; only 'session' is. "
                "Per-agent and per-day windows need durable storage."
            )
        if self.when_exceeded not in ("escalate", "block"):
            raise LimitSpecError(
                f"When exceeded: {self.when_exceeded!r} must be 'escalate' or 'block'."
            )
        if not (self.limit > 0):
            raise LimitSpecError(f"Limit: {self.limit!r} must be a positive number.")
        if self.match:
            try:
                re.compile(self.match)
            except re.error as err:
                raise LimitSpecError(f"Match: {self.match!r} is not a valid regex ({err}).") from err

    def measure(self, tool_args: dict[str, Any] | None) -> float:
        """How much this action contributes to the running total."""
        if self.is_count:
            return 1.0
        field_name = self.sum_field or ""
        return _numeric_field(tool_args, field_name)

    def format_total(self, total: float) -> str:
        if self.unit == "$":
            return f"${total:,.0f}"
        if self.is_count:
            return f"{int(total)}"
        return f"{total:,.0f}{(' ' + self.unit) if self.unit else ''}"


def _coerce(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = re.sub(r"[^0-9.\-]", "", str(value))
    try:
        return float(cleaned)
    except ValueError:
        return None


def _numeric_field(tool_args: dict[str, Any] | None, field_name: str) -> float:
    """Read a numeric field out of tool arguments.

    Exact key first. For the money aliases we also accept near-misses
    (`total_cost` for `amount`), because callers spell currency fields a dozen
    ways and a missed amount means a spend limit silently never fires.
    """
    args = tool_args or {}

    if field_name in args:
        value = _coerce(args[field_name])
        if value is not None and value > 0:
            return value

    if field_name.lower() in _AMOUNT_ALIASES:
        for key, raw in args.items():
            if any(alias in key.lower() for alias in _AMOUNT_ALIASES):
                value = _coerce(raw)
                if value is not None and value > 0:
                    return value

    return 0.0


def parse_limit_spec(raw: str) -> LimitSpec | None:
    """Pull a LimitSpec out of a policy's markdown, or None if it declares none."""
    accumulate = _field(raw, "Accumulate")
    limit_raw = _field(raw, "Limit")
    if not accumulate and not limit_raw:
        return None
    if not accumulate or not limit_raw:
        raise LimitSpecError(
            "A cumulative policy needs both 'Accumulate:' and 'Limit:'; "
            f"got Accumulate={accumulate!r} Limit={limit_raw!r}."
        )

    unit = "$" if limit_raw.strip().startswith("$") else ""
    limit = _coerce(limit_raw)
    if limit is None:
        raise LimitSpecError(f"Limit: {limit_raw!r} is not a number.")

    risk_floor_raw = _field(raw, "Risk floor")
    risk_floor = _coerce(risk_floor_raw) if risk_floor_raw else None

    spec = LimitSpec(
        accumulate=accumulate.strip(),
        limit=limit,
        scope=(_field(raw, "Scope") or "session").strip().lower(),
        when_exceeded=(_field(raw, "When exceeded") or "escalate").strip().lower(),
        risk_floor=risk_floor if risk_floor is not None else 70.0,
        unit=unit,
        match=_field(raw, "Match"),
    )
    spec.validate()
    return spec


def _field(raw: str, name: str) -> str | None:
    m = re.search(rf"^{re.escape(name)}:\s*(.+)$", raw, re.M | re.I)
    return m.group(1).strip() if m else None
