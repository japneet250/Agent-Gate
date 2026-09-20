"""Probe the firewall at its decision boundaries.

    python -m agentgate_engine.redteam [--json out.json] [--concurrency 4]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from . import run_redteam


async def main() -> int:
    ap = argparse.ArgumentParser(prog="agentgate-redteam")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero if any defect is found")
    args = ap.parse_args()

    from ..engine import warmup

    await warmup()
    print("probing the decision boundary…", file=sys.stderr)
    report = await run_redteam(concurrency=args.concurrency, progress=True)

    print()
    print(report.render())

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report.to_dict(), indent=2))
        print(f"\nwrote {args.json_out}", file=sys.stderr)

    return 1 if (args.strict and report.defects) else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
