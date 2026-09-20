"""Running a traffic log through AgentGate and writing up what it found.

The cost problem is the design problem. A capture has hundreds of thousands of
connections and the judge costs ~2s and real money per call, so judging all of
them is neither affordable nor useful — the overwhelming majority are a laptop
fetching a web page.

Same answer as the product: triage first, reason second.

  tier 1  every connection, deterministic, free. Port, direction, volume,
          beaconing regularity, destination rarity.
  tier 2  the LLM judge, only on what tier 1 could not dismiss, and on the
          worst first so a budget spends where it matters.
  tier 3  cumulative limits across each host's whole session, which is where
          slow exfiltration actually shows up.

The report answers who, what, when and how, because a finding nobody can act on
is not a finding.
"""

from __future__ import annotations

import asyncio
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from .loader import Connection
from .mapper import connection_to_action, _is_internal


@dataclass
class Triage:
    """A deterministic first pass. Free, and runs on everything."""

    score: float
    reasons: list[str] = field(default_factory=list)


@dataclass
class Finding:
    host: str
    tool: str
    destination: str
    decision: str
    risk: int
    reasoning: str
    policy: str | None
    first_seen: datetime
    last_seen: datetime
    connections: int
    bytes_out: int
    triage_reasons: list[str] = field(default_factory=list)


@dataclass
class ForensicReport:
    total_connections: int
    hosts: int
    judged: int
    findings: list[Finding]
    host_totals: dict[str, dict[str, Any]]
    window: tuple[datetime, datetime] | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "totalConnections": self.total_connections,
            "hosts": self.hosts,
            "connectionsJudged": self.judged,
            "window": [self.window[0].isoformat(), self.window[1].isoformat()]
            if self.window else None,
            "findings": [
                {
                    "who": f.host, "what": f.tool, "where": f.destination,
                    "when": {"first": f.first_seen.isoformat(), "last": f.last_seen.isoformat()},
                    "decision": f.decision, "risk": f.risk, "policy": f.policy,
                    "why": f.reasoning, "signals": f.triage_reasons,
                    "connections": f.connections, "bytesOut": f.bytes_out,
                }
                for f in self.findings
            ],
            "hostTotals": self.host_totals,
        }

    def render(self) -> str:
        lines = [
            "AgentGate — traffic forensic report",
            "=" * 62,
            f"connections analysed : {self.total_connections:,}",
            f"distinct hosts       : {self.hosts}",
            f"sent to the judge    : {self.judged:,} "
            f"({self.judged / self.total_connections:.1%} of traffic)"
            if self.total_connections else "",
        ]
        if self.window:
            lines.append(f"window               : {self.window[0]:%Y-%m-%d %H:%M} "
                         f"to {self.window[1]:%Y-%m-%d %H:%M} UTC")
        lines += ["", f"FINDINGS ({len(self.findings)})", "-" * 62]
        if not self.findings:
            lines.append("  nothing above the reporting threshold")
        for f in self.findings:
            lines += [
                f"  [{f.decision.upper()}] risk {f.risk}   {f.host}  ->  {f.destination}",
                f"      what       : {f.tool} · {f.connections} connection(s) · "
                f"{f.bytes_out:,} bytes out",
                f"      when       : {f.first_seen:%Y-%m-%d %H:%M:%S} to {f.last_seen:%H:%M:%S} UTC",
                f"      policy     : {f.policy or '—'}",
                f"      why        : {f.reasoning[:200]}",
            ]
            if f.triage_reasons:
                lines.append(f"      signals    : {', '.join(f.triage_reasons)}")
            lines.append("")
        return "\n".join(l for l in lines if l is not None)


# --- tier 1: deterministic triage ---------------------------------------------

_BEACON_MIN_SAMPLES = 6


def triage(conns: list[Connection]) -> Triage:
    """Score a host's connections to one destination. No model, no cost."""
    reasons: list[str] = []
    score = 0.0
    first = conns[0]
    outbound = _is_internal(first.src_ip) and not _is_internal(first.dst_ip)

    if first.dst_port in (4444, 31337, 1337, 6667):
        score += 60; reasons.append(f"port {first.dst_port} associated with C2/backdoor")

    total_out = sum(c.bytes_out for c in conns)
    if outbound and total_out > 100_000_000:
        score += 40; reasons.append(f"{total_out / 1e6:.0f}MB sent outbound")
    elif outbound and total_out > 10_000_000:
        score += 20; reasons.append(f"{total_out / 1e6:.0f}MB sent outbound")

    if outbound and total_out > 0:
        ratio = total_out / max(sum(c.bytes_in for c in conns), 1)
        if ratio > 20 and total_out > 1_000_000:
            score += 25; reasons.append(f"upload/download ratio {ratio:.0f}:1")

    # Beaconing: a human browses irregularly, malware checks in on a timer.
    if len(conns) >= _BEACON_MIN_SAMPLES:
        times = sorted(c.ts.timestamp() for c in conns)
        gaps = [b - a for a, b in zip(times, times[1:]) if b > a]
        if len(gaps) >= _BEACON_MIN_SAMPLES - 1:
            mean = statistics.fmean(gaps)
            if mean > 0:
                cv = statistics.pstdev(gaps) / mean
                if cv < 0.15:
                    score += 45
                    reasons.append(
                        f"regular {mean:.0f}s interval across {len(conns)} connections "
                        f"(variation {cv:.0%}) — beaconing"
                    )

    if not _is_internal(first.src_ip) and first.dst_port in (22, 3389, 23, 5900):
        score += 55; reasons.append("inbound remote access from an external address")

    if len(conns) > 500:
        score += 15; reasons.append(f"{len(conns)} connections to one destination")

    return Triage(score=min(score, 100.0), reasons=reasons)


# --- the run ------------------------------------------------------------------

async def analyse(
    connections: Iterable[Connection],
    *,
    judge_budget: int = 40,
    triage_threshold: float = 30.0,
    report_threshold: int = 30,
    progress: bool = False,
) -> ForensicReport:
    """Triage everything, judge the worst of it, report what matters."""
    from ..engine import evaluate_detailed, reset_sessions

    conns = list(connections)
    if not conns:
        return ForensicReport(0, 0, 0, [], {}, None)

    # Group by (host, destination): the unit a finding is about, and the unit
    # beaconing and volume are visible in.
    groups: dict[tuple[str, str], list[Connection]] = defaultdict(list)
    for c in conns:
        groups[(c.src_ip, c.host or c.dst_ip)].append(c)

    scored = sorted(
        ((key, group, triage(group)) for key, group in groups.items()),
        key=lambda t: -t[2].score,
    )
    candidates = [t for t in scored if t[2].score >= triage_threshold][:judge_budget]

    await reset_sessions()
    findings: list[Finding] = []
    for i, ((host, dest), group, tri) in enumerate(candidates, 1):
        if progress:
            print(f"  judging {i}/{len(candidates)}: {host} -> {dest}", flush=True)

        # Judge the heaviest connection in the group; the cumulative detector
        # sees the rest through the host's session totals.
        worst = max(group, key=lambda c: c.bytes_out)
        action = connection_to_action(worst)
        detail = await evaluate_detailed(action)

        risk = max(detail.result.risk_score, int(tri.score))
        if risk < report_threshold:
            continue
        findings.append(Finding(
            host=host, tool=action.tool_name, destination=dest,
            decision=detail.result.decision, risk=risk,
            reasoning=detail.result.reasoning, policy=detail.result.violated_policy,
            first_seen=min(c.ts for c in group), last_seen=max(c.ts for c in group),
            connections=len(group), bytes_out=sum(c.bytes_out for c in group),
            triage_reasons=tri.reasons,
        ))

    findings.sort(key=lambda f: -f.risk)

    totals: dict[str, dict[str, Any]] = {}
    for c in conns:
        t = totals.setdefault(c.src_ip, {"connections": 0, "bytesOut": 0, "destinations": set()})
        t["connections"] += 1
        t["bytesOut"] += c.bytes_out
        t["destinations"].add(c.dst_ip)
    for t in totals.values():
        t["destinations"] = len(t["destinations"])

    return ForensicReport(
        total_connections=len(conns),
        hosts=len(totals),
        judged=len(candidates),
        findings=findings,
        host_totals=dict(sorted(totals.items(), key=lambda kv: -kv[1]["bytesOut"])[:20]),
        window=(min(c.ts for c in conns), max(c.ts for c in conns)),
    )
