# @agentgate/engine — the Judge

Person 2's package. The slow path of AgentGate's two-tier evaluation: the gateway's
deterministic rules run first, and everything they don't settle comes here.

Integration details for the gateway are in [INTEGRATION.md](./INTEGRATION.md).

## Quick start

```bash
# from the repo root, with OPENAI_API_KEY in .env
npm run test  -w @agentgate/engine        # 28 offline tests, no API key needed
npm run test:live -w @agentgate/engine    # 18 live scenarios against GPT-4o (a few cents)
```

```ts
import { evaluate, warmup } from '@agentgate/engine';

await warmup();
const result = await evaluate(action, { sessionId: 'session-1' });
// { riskScore: 100, decision: 'block', reasoning: '…', violatedPolicy: 'PII Protection', latencyMs: 1790 }
```

## Pipeline

```
classifier → policy_retriever → risk_judge → decision_gate → pattern_detector
```

| Node | Job | Model |
| --- | --- | --- |
| `classifier` | labels the action `data_access` / `external_comms` / `financial` / `system_modification` / `other` | gpt-4o-mini, regex fallback |
| `policy_retriever` | hybrid search over `src/policies/*.md`: `0.7 × cosine + 0.3 × keyword + 0.15 category boost`, top 5 | text-embedding-3-small |
| `risk_judge` | scores 0–100 with reasoning, grounded in the retrieved policies | gpt-4o, function calling |
| `decision_gate` | `<30` allow · `30–69` escalate · `≥70` block | none |
| `pattern_detector` | cumulative spend, repeat loops, bulk reads, privilege creep | none |

### Two things worth knowing about the design

**The pattern detector can only make a decision stricter.** It never turns a block into an
allow. It runs last precisely so it can override.

**Cumulative policies are hidden from the judge.** A policy marked `Enforced by:
pattern_detector` is retrieved and reported but never shown to the risk judge. Without this
the judge sees the *Cumulative Spending Limit* policy, notices a total is "approaching" the
limit, and escalates early — at transaction 3, 7, 9 or 12 depending on the run. The detector
holds exact counts and fires at 13, every time. Splitting ownership this way is what makes
the cumulative demo deterministic.

## Query enrichment

`src/enrich.ts` annotates the retrieval query with the kinds of sensitive data it detects in
the arguments, because a raw `123-45-6789` shares no vocabulary with the phrase "personally
identifiable information". It is a retrieval aid only — it makes no decision and blocks
nothing. With it, *PII Protection* retrieves at rank 1 for an SSN-bearing email that never
uses the word "PII"; without it, rank 2.

## Guardrails

The evaluator gets evaluated too. All four live in `src/guardrails.ts`:

1. **Structured output** — score clamped to 0–100; a non-numeric score defaults to 50
   (escalate), never to allow.
2. **Policy grounding** — a cited policy is dropped unless it both exists in the store *and*
   was retrieved for this action. No hallucinated citations reach the dashboard.
3. **Consistency** — the identical action scored twice in one session takes the stricter
   score. Keyed on argument *values*, so a benign email never inherits a dangerous one's score.
4. **Latency budget** — an evaluation over budget is flagged on the result.

Anything that fires is reported in `evaluateDetailed().guardrails`.

## Failure behaviour

`evaluate()` never throws. Each layer degrades instead:

| Failure | Behaviour |
| --- | --- |
| No `OPENAI_API_KEY` | risk 50 → escalate, `degraded: true` |
| Classifier down | regex heuristic category |
| Embeddings down | keyword-only retrieval |
| Judge down or timing out | risk 50 → escalate, never allow |
| Provider failing repeatedly | circuit opens for 30s, skips the call rather than paying the timeout |
| Anything else | risk 50 → escalate, reason on the result |

## Measured behaviour

28 offline tests pass with no API key. 18 live scenarios pass against GPT-4o — 5 safe
allowed, 7 dangerous blocked (including a prompt injection that tries to talk the judge into
scoring 0), 4 ambiguous escalated or blocked, plus semantic retrieval and the cumulative
scenario.

```
latency over 29 live evaluations: mean 1842ms · p50 1753ms · p95 2740ms · max 3252ms
```

That is slower than the ~500ms the project spec assumed. The fast path is where low latency
lives; this path buys judgement.

## Adding a policy

Drop a markdown file in `src/policies/`. Needs `# Title`, a body, `Severity:` and
`Applies to:`. Optionally `Enforced by: pattern_detector`. Nothing to register.

## Storage

The engine talks only to the `VectorStore` and `SessionStore` interfaces, both in-memory by
default. `configureStores()` swaps in Vectorize and D1 — see INTEGRATION.md §6.

## Tracing

Set `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` and each evaluation becomes one trace: a
span per node, a generation per LLM call carrying model, tokens and cost, and events for
every guardrail and pattern alert. No-ops without keys. Call `flushTraces()` before exit.
