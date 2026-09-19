# @agentgate/engine — the Judge

Person 2's package. The **slow path** of AgentGate's two-tier evaluation: the gateway's
deterministic rules run first, and everything they don't settle comes here.

Python service. The gateway (TypeScript) calls it over HTTP.

- **How it works, with diagrams:** [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Plugging it in:** [INTEGRATION.md](./INTEGRATION.md)
- **Seeing it work:** [RUNBOOK.md](./RUNBOOK.md)
- **Deploying it:** [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## Quick start

```bash
cd packages/engine
./setup.sh                                   # venv + deps

./venv/bin/pytest -q                         # 29 offline tests, no API key needed
./venv/bin/python demo.py                    # narrated four-scene walkthrough
./venv/bin/python test_live.py               # 18 live scenarios against GPT-4o
./venv/bin/uvicorn server:app --port 8000    # the service Person 1 calls
# then open http://localhost:8000/dashboard  — click-to-test console
```

```python
from agentgate_engine import evaluate, warmup
from agentgate_shared import AgentAction

await warmup()
result = await evaluate(AgentAction(
    agentId="support-bot", toolName="send_email",
    toolArgs={"body": "SSN 123-45-6789"}, sessionId="s-1",
))
# EvalResult(risk_score=100, decision='block',
#            violated_policy='PII Protection', latency_ms=1790, …)
```

---

## Pipeline

```
classifier → policy_retriever → risk_judge → decision_gate → pattern_detector
```

| Node | Job | Model |
| --- | --- | --- |
| `classifier` | labels the action `data_access` / `external_comms` / `financial` / `system_modification` / `other` | gpt-4o-mini, regex fallback |
| `policy_retriever` | hybrid search over 19 markdown policies: `0.7 × cosine + 0.3 × keyword + 0.15 category boost`, top 5 | text-embedding-3-small |
| `risk_judge` | scores 0–100 with reasoning, grounded in the retrieved policies | gpt-4o, function calling |
| `decision_gate` | `<30` allow · `30–69` escalate · `≥70` block | none |
| `pattern_detector` | cumulative spend, repeat loops, bulk reads, privilege creep | none |

### Cumulative limits are policy, not code

AgentGate is a firewall for **any** enterprise, so what it counts cannot be baked
into Python. A bank counts spend; a hospital counts patient records; a SaaS
company counts exported rows. A policy declares its own rule:

```markdown
# Cumulative Spending Limit
Splitting a large purchase into smaller ones to evade an approval limit is
approval-threshold splitting.
Severity: critical
Applies to: financial
Enforced by: pattern_detector
Accumulate: sum(toolArgs.amount)
Scope: session
Limit: $5,000
When exceeded: escalate
Risk floor: 75
```

The pattern detector is a generic accumulator over whatever policies declare one.
Adding a dimension means writing a markdown file:

```markdown
# PHI Access Volume            |  # Bulk Export Row Volume
Applies to: data_access        |  Applies to: data_access
Accumulate: count()            |  Accumulate: sum(toolArgs.rowCount)
Limit: 5                       |  Limit: 100000
When exceeded: escalate        |  When exceeded: escalate
```

| Field | Meaning |
| --- | --- |
| `Accumulate:` | `count()` or `sum(toolArgs.<field>)` — deliberately not a query language |
| `Applies to:` | which action categories the limit sees |
| `Match:` | optional regex on the tool name, for a family of tools inside a category |
| `Scope:` | `session` (per-agent and per-day need durable storage; they raise rather than pretend) |
| `Limit:` | the threshold; a leading `$` formats totals as currency |
| `When exceeded:` | `escalate` or `block` |
| `Risk floor:` | the minimum risk score to force when it trips |

`POST /policies/reload` re-reads the directory without dropping session counters,
so an operator edits a file and the control is live. A malformed limit **raises**
rather than being ignored — silently disabling a control the operator believes is
on would be worse than failing to start.

Examples that are not loaded by default live in `policies/examples/`.

**Loop detection stays built in** and is not policy-defined, because it protects
the firewall itself rather than enforcing a business rule: an agent repeating one
identical call is looping or under prompt injection, and that is true for every
customer.

### Three design decisions worth knowing

**The pattern detector can only make a decision stricter.** It never turns a block into an
allow. It runs last precisely so it can override.

**Cumulative policies are hidden from the judge.** A policy marked `Enforced by:
pattern_detector` is retrieved and reported but never shown to the risk judge, and the judge is
not told the spend limit. Without both of those, the judge sees a total "approaching" a limit it
can only guess at and escalates early — I measured it firing at transaction 3, 7, 9 and 12
across runs. The detector holds exact counts and fires at 13, every time. Splitting ownership
this way is what makes the cumulative demo deterministic.

**Action identity is value-based, not shape-based.** `fingerprint()` hashes argument *values*.
Keying on which argument keys exist made 30 purchase orders to 30 vendors look like one repeated
call, and forced a benign email to inherit an SSN-bearing email's risk score.

---

## Query enrichment

`enrich.py` annotates the retrieval query with the kinds of sensitive data it detects in the
arguments, because a raw `123-45-6789` shares no vocabulary with the phrase "personally
identifiable information". It is a retrieval aid only — it makes no decision and blocks nothing.

With it, *PII Protection* retrieves at **rank 1** for an SSN-bearing email that never uses the
word "PII"; without it, rank 2. It also keeps retrieval working when embeddings are down: in one
live run the policy index failed to embed and PII Protection still ranked 1 on keyword alone.

---

## Guardrails

The evaluator gets evaluated too. All four from the project spec, in `guardrails.py`:

1. **Structured output** — score clamped to 0–100; a non-numeric score defaults to 50
   (escalate), never to allow.
2. **Policy grounding** — a cited policy is dropped unless it both exists in the store *and* was
   retrieved for this action. No hallucinated citations reach the dashboard.
3. **Consistency** — the identical action scored twice in one session takes the stricter score.
4. **Latency budget** — an evaluation over budget is flagged on the result.

Anything that fires appears in `EvalDetail.guardrails` and in the `guardrails` array on the HTTP
response.

---

## Failure behaviour

`evaluate()` never raises. Each layer degrades instead:

| Failure | Behaviour |
| --- | --- |
| No `OPENAI_API_KEY` | risk 50 → escalate, `degraded: true` |
| Classifier down | regex heuristic category |
| Embeddings down | keyword-only retrieval |
| Judge down or timing out | risk 50 → escalate, never allow |
| Provider failing repeatedly | circuit opens for 30s, fails fast rather than paying the timeout |
| Anything else | risk 50 → escalate, reason on the result |

The bias is always the same: **a firewall that cannot judge must not allow.**

---

## Measured behaviour

29 offline tests pass with no API key. 18 live scenarios pass against GPT-4o — 5 safe allowed,
7 dangerous blocked (including a prompt injection that tries to talk the judge into scoring 0),
4 ambiguous escalated or blocked, plus semantic retrieval and the cumulative scenario.

```
latency over 29 live evaluations: mean 1842ms · p50 1753ms · p95 2740ms · max 3252ms
```

Slower than the ~500ms the project spec assumed. The fast path is where low latency lives; this
path buys judgement. On a degraded connection p95 exceeded 15s and the circuit breaker opened —
see INTEGRATION.md.

---

## Layout

```
src/agentgate_engine/
  engine.py         evaluate() / evaluate_detailed() — the public surface
  graph.py          LangGraph wiring, one traced span per node
  nodes/            the five pipeline stages
  policy_store.py   parsing, embedding and hybrid retrieval
  policies/*.md     the 19-policy knowledge base
  guardrails.py     validation of the judge's own output
  enrich.py         retrieval query annotation
  stores.py         VectorStore / SessionStore seams, in-memory by default
  llm.py            timeouts, retries, circuit breaker, cost accounting
  trace.py          LangFuse adapter (no-ops without keys)
server.py           FastAPI service
demo.py             narrated walkthrough
tests/              offline suite (mock model)
test_live.py        live suite (real model)
```

---

## Adding a policy

Drop a markdown file in `src/agentgate_engine/policies/`. It needs `# Title`, a body,
`Severity:` and `Applies to:`. Optionally `Enforced by: pattern_detector`. Nothing to register.

```markdown
# Contractor Data Access
Contractor accounts may not read customer payment records.
Severity: high
Applies to: data_access
```

---

## Tracing

Set `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` and each evaluation becomes one trace: a span
per node, a generation per LLM call carrying model, tokens and cost, and events for every
guardrail and pattern alert. No-ops without keys.
