# @agentgate/engine — the Judge (Person 2)

The slow path. The gateway runs its deterministic rules first; anything they don't
decide comes here.

## Public API

```ts
import { evaluate, warmup } from '@agentgate/engine';

await warmup();                       // once at boot — embeds the policy index
const result = await evaluate(action, { sessionId, recentActions });
// → { riskScore, decision, reasoning, violatedPolicy?, latencyMs }
```

## Pipeline

```
classifier → policy_retriever → risk_judge → decision_gate → pattern_detector
```

| Node | What it does | Model |
| --- | --- | --- |
| `classifier` | labels the action `data_access` / `external_comms` / `financial` / `system_modification` / `other` | gpt-4o-mini + heuristic fallback |
| `policy_retriever` | hybrid search over `src/policies/*.md` — 0.7 × cosine + 0.3 × keyword overlap + category boost, top 5 | text-embedding-3-small |
| `risk_judge` | scores 0–100 with reasoning, grounded in the retrieved policies | gpt-4o, function calling |
| `decision_gate` | <30 allow · 30–69 escalate · ≥70 block | none |
| `pattern_detector` | cumulative spend, repeat loops, bulk reads, privilege creep — can only make a decision stricter | none |

## Guardrails

- Judge output is clamped to 0–100 and its cited policy is dropped unless it exists in
  the store **and** was one of the retrieved ones (no hallucinated citations).
- Every LLM call has a latency budget (`AGENTGATE_LATENCY_BUDGET_MS`, default 2000ms).
- Any node failure degrades rather than throws: classifier → heuristic, retriever →
  keyword-only, judge → risk 50 / escalate to a human.

## Adding a policy

Drop a markdown file in `src/policies/`. It needs `# Title`, a body, `Severity:` and
`Applies to:`. Nothing else to register.

## Tracing

Set `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` and every node becomes a span under one
`agentgate.evaluate` trace. Without them tracing is a no-op. Call `flushTraces()` before exit.

## Run

```bash
npm run test -w @agentgate/engine     # 6 single-action cases + the 30 × $400 cumulative scenario
```
