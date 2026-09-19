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
