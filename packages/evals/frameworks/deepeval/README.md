# DeepEval cross-check

A second, independent framework scoring **the same scenarios and the same engine
decisions** as `packages/evals`. It exists to answer one question:

> Does an off-the-shelf eval framework agree with our custom harness?

It is **not** a second accuracy number, and it must never be quoted as one. If
DeepEval and the TypeScript harness disagree, one of them has a bug — the script
exits non-zero and says so rather than averaging them or quietly picking a
winner.

## Run it

```bash
./setup.sh                                  # venv + deepeval, one time
./venv/bin/python run_deepeval.py           # offline cross-check, no API spend
```

Offline mode reads the decisions already in `packages/evals/report.json`, so it
needs neither the engine running nor an API key, and costs nothing.

```bash
./venv/bin/python run_deepeval.py --live --limit 20      # calls the engine, costs money
./venv/bin/python run_deepeval.py --geval --limit 10     # LLM-scored reasoning quality
./venv/bin/python run_deepeval.py --category=dangerous
```

`--live` mirrors what `packages/evals/src/engine/http.ts` sends, including the
`Authorization: Bearer` header when `AGENTGATE_API_KEY` is set.

## Why its own venv

`deepeval` pulls a large dependency tree. Installing it into the engine's venv
risks moving a version the engine depends on, and a broken engine is a much
worse problem than a missing eval framework.

## Why decision correctness is not LLM-scored

The metric is a three-way classification against a fixed label. Scoring that
with a judge model would add variance to the one number in this project that
should have none — and it would mean two different judges (ours and DeepEval's)
disagreeing for reasons that have nothing to do with the engine. `GEval` is
available behind `--geval` for *reasoning quality*, which is a genuinely
subjective thing worth an LLM's opinion.

## What it excludes, and why

Offline mode scores only rows the harness marked `scored`. A row bucketed
`invalid` (schema non-conformance) or `skipped` (rate limit) is a plumbing
failure, not a wrong decision. Counting those here would reintroduce exactly the
bias the TypeScript harness goes out of its way to bucket away.

## Status

The cross-check runs against whatever is in `report.json`. As of writing that is
the **pre-reconciliation** engine — four calibration decisions (D1–D4 in
`SHARED_CONTEXT.md`) are outstanding on P2's side, and until they land the
engine's 71.0% reflects a policy disagreement rather than its ceiling.

**Do not quote DeepEval numbers from a pre-reconciliation run.** The cross-check
itself is still meaningful, because agreement between two frameworks is a
property of the harnesses, not of the engine's calibration.
