"""Run a traffic log through AgentGate.

    python -m agentgate_engine.cse <conn.log> [--json out.json] [--budget 40]

Reads Zeek conn.log, CSV or JSON lines. Triage is free and runs on everything;
only what triage cannot dismiss reaches the judge.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from . import analyse, load_connections


async def main() -> int:
    ap = argparse.ArgumentParser(prog="agentgate-cse")
    ap.add_argument("logfile", help="conn.log, CSV or JSON lines")
    ap.add_argument("--json", dest="json_out", help="also write the report as JSON")
    ap.add_argument("--budget", type=int, default=40,
                    help="max connection groups sent to the judge (default 40)")
    ap.add_argument("--triage-threshold", type=float, default=30.0)
    ap.add_argument("--limit", type=int, help="only read the first N records")
    args = ap.parse_args()

    path = Path(args.logfile)
    if not path.exists():
        print(f"no such file: {path}", file=sys.stderr)
        return 2

    from ..engine import warmup

    conns = load_connections(path, limit=args.limit)
    print(f"loaded {len(conns):,} connections from {path.name}", file=sys.stderr)
    if not conns:
        print("no connection records found — is this a traffic log?", file=sys.stderr)
        return 1

    await warmup()
    report = await analyse(
        conns, judge_budget=args.budget,
        triage_threshold=args.triage_threshold, progress=True,
    )
    print()
    print(report.render())

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report.to_dict(), indent=2, default=str))
        print(f"\nwrote {args.json_out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
