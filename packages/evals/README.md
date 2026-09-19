# @agentgate/evals

Eval harness for AgentGate's `evaluate()` decisions, plus the temporary stub
engine everything else runs against until P2's engine lands.

```bash
npm run eval -w @agentgate/evals                      # 100 scenarios, stub engine
npm run eval -w @agentgate/evals -- --category=ambiguous
npm run eval -w @agentgate/evals -- --engine=engine   # force P2's real engine
npm run eval -w @agentgate/evals -- --strict --min-macro-f1=0.85   # fail on regression
```

Flags: `--engine=stub|engine`, `--category=safe|dangerous|ambiguous|cumulative`,
`--show-failures=N`, `--strict`, `--min-macro-f1=N`.

## Scenarios

`scenarios.json` — 100 labelled cases, `expected` is ground truth:

| category | n | expected |
| --- | --- | --- |
| `safe` | 40 | `allow` |
| `dangerous` | 30 | `block` |
| `ambiguous` | 20 | `escalate` |
| `cumulative` | 10 | mixed — only decidable from `priorActions` |

Cumulative scenarios carry `priorActions`; the loader replays them into a
`SessionContext` using the same accounting the demo agents use (spend books on
`approve_payment` only), so the harness and the live demo put the engine in the
same state.

## Output

Per-class precision / recall / F1, a confusion matrix, a per-category breakdown,
latency percentiles, and every mismatch with the policy that fired. Full detail
is written to `report.json`.

## Engine swap

`resolveEvaluate()` reads `AGENTGATE_ENGINE` (`stub` default, or `engine`) and
dynamically imports `@agentgate/engine`, falling back to the stub with a warning
if it doesn't export `evaluate()` yet. **P2: export `evaluate` from the package
root and both the harness and the demo agents pick it up.**

`src/engine/stub.ts` is ~12 hand-written rules. It exists so nobody is blocked —
it is not a second engine, and it gets deleted once P2's is wired.

## Model comparison

The harness is model-parametrized. `--model` takes a comma-separated list; give
it more than one and you get a side-by-side comparison.

```bash
npm run eval -w @agentgate/evals -- --model=stub               # default
npm run eval -w @agentgate/evals -- --model=openai,gemini      # dual-model
npm run eval -w @agentgate/evals -- --model=stub,engine        # rules vs P2
```

`src/models/prompt.ts` holds **one** provider-agnostic prompt, used byte-for-byte
by both providers; each uses its own structured-output mechanism (OpenAI
`json_schema`, Gemini `responseSchema`) so neither is asked to hold the format
together with prompt text alone. That is what makes the comparison fair, and
`npm run verify:judge -w @agentgate/evals` asserts it against local mock
endpoints — identical system prompt and identical input on the wire, no API spend.

Model ids come from `OPENAI_JUDGE_MODEL` / `GEMINI_JUDGE_MODEL` (see
`.env.example`) because provider model names move faster than this repo does.
A missing API key skips that model with a warning instead of failing the run.

Two or more models also writes `report.by-model.json`: per-model metrics plus
every scenario where the models disagreed.

## Regression mode

Every run diffs itself against the previous `report.json`.

```bash
npm run eval -w @agentgate/evals -- --strict                   # exit 1 on regression
npm run eval -w @agentgate/evals -- --min-macro-f1=0.85 --max-delta=0.03
npm run eval -w @agentgate/evals -- --update-baseline          # accept new numbers
```

Checks, all configurable: a macro-F1 floor (default 0.8), a per-class recall
floor (default 0.7), and the largest tolerated drop vs the previous run
(default 0.05). Output names every scenario that flipped, marked `fixed` or
`BROKEN`.

Two things keep it honest:

- A **scenario-set hash** guards the diff. A report scored on a different set of
  scenarios is reported as not comparable rather than silently compared.
- A **failing run does not overwrite the baseline** — it parks in
  `report.failed.json`, so one bad commit cannot quietly reset the bar. Pass
  `--update-baseline` to accept it deliberately.

This is the safety net for P2's prompt changes. Run it before you push.

## Eval run history (MongoDB Atlas)

Each run is persisted as a document (timestamp, model, precision/recall/F1,
confusion matrix, scenario hash, report path, pass/fail). Set `MONGODB_URI`;
without it the run warns and carries on, like the observability backends.
`--no-history` skips it.

**Scope:** P3 eval runs only. Agent action logs belong in P1's D1 store.
