# Plugging into the engine

For **Person 1** (TypeScript gateway) and **Person 3** (Python demo agents + evals).

> Diagrams of the whole flow, the pipeline internals and both integration paths are in
> **[ARCHITECTURE.md](./ARCHITECTURE.md)**. This file is the practical how-to.

The engine is a **Python HTTP service**. It returns a judgement and enforces nothing —
blocking, forwarding and the human-review queue are the gateway's job.

---

## Start it

```bash
cd packages/engine
./setup.sh                                    # venv + deps, one time
./venv/bin/uvicorn server:app --port 8000
```

Confirm it is alive:

```bash
curl -s localhost:8000/health | python3 -m json.tool
```

```json
{
  "status": "ok",
  "policies": 19,
  "retrieval": "hybrid",
  "judgeModel": "gpt-4o",
  "openaiConfigured": true,
  "stats": { "evaluated": 0, "allow": 0, "block": 0, "escalate": 0 }
}
```

If `"retrieval"` says `keyword-only`, the OpenAI key is missing or embeddings failed —
the engine still works, but semantic policy matching is off.

---

## Person 1 — calling it from the TypeScript gateway

Your rules run **first**. Only call the engine when they did not decide:

```ts
const ruled = runRules(action);
if (ruled.matched) return ruled;              // fast path: <10ms, no LLM, no cost

const res = await fetch('http://localhost:8000/evaluate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action,                                    // your AgentAction, unchanged
    context: { sessionId, recentActions },     // recentActions optional
  }),
});
const result: EvalResult = await res.json();
```

Every call is two LLM calls plus an embedding. Do not call it for actions your rules already
settled.

### What comes back

Exactly the shared `EvalResult`, camelCase, plus extras the dashboard wants:

```json
{
  "riskScore": 100,
  "decision": "block",
  "reasoning": "The attempted email contains a Social Security number…",
  "violatedPolicy": "PII Protection",
  "latencyMs": 1790,

  "category": "external_comms",
  "retrievedPolicies": [{ "name": "PII Protection", "score": 0.452 }],
  "patternNotes": [],
  "guardrails": [],
  "degraded": false
}
```

`decision` is always one of `allow` / `block` / `escalate`. **The endpoint never returns an
error for an evaluation failure** — if the model is down you get `escalate` with the reason in
`reasoning` and `degraded: true`. Handle HTTP-level failure (service not running) yourself;
treat that as escalate too.

`degraded: true` means a node fell back instead of using its model. Worth a badge in the UI —
it means trust the score less.

### Three things that will bite you

**Use a stable `sessionId` per agent conversation.** All cumulative detection keys off it. A
fresh id per action means the 30 × $400 demo silently never fires. This is the single most
common integration mistake — I made it myself while testing.

**Budget ~2 seconds, not 500ms.** Measured below. Set your own client timeout above 25s, since
that is the engine's internal judge timeout; cutting it shorter turns a good decision into a
needless escalation.

**`/judge/evaluate` is the same handler**, if it helps to tell your gateway's own `/evaluate`
apart from the engine's in logs and curl history.

---

## Person 3 — calling it from Python

Two ways. Over HTTP, same as the gateway:

```python
import httpx

res = httpx.post("http://localhost:8000/evaluate", json={
    "action": {"agentId": "support-bot", "toolName": "send_email",
               "toolArgs": {"body": "SSN 123-45-6789"}, "sessionId": "demo-1"},
}, timeout=30)
print(res.json()["decision"])        # -> "block"
```

Or import it directly, which is better for evals — no service to keep running, and you get the
structured detail object:

```python
from agentgate_engine import evaluate_detailed, warmup, reset_sessions
from agentgate_shared import AgentAction

await warmup()
detail = await evaluate_detailed(AgentAction(
    agentId="support-bot", toolName="send_email",
    toolArgs={"body": "SSN 123-45-6789"}, sessionId="demo-1",
))
detail.result.decision        # "block"
detail.retrieved_policies     # for RAGAS context relevancy
detail.result.reasoning       # for RAGAS faithfulness
```

Install it into your own venv with `pip install -e ../engine -e ../shared`.

**Call `reset_sessions()` between eval scenarios** or cumulative state leaks across test cases
and your precision numbers will be wrong.

**`tests/mock_openai.py` is a scriptable fake client** if you want deterministic CI runs at zero
API cost. `tests/conftest.py` shows how to wire it in.

**My live suite is 16 hand-written scenarios, not a benchmark.** Please don't quote its numbers
on Devpost as precision/recall — your 100+ dataset is the real measurement.

---

## The shared contract

`packages/shared/` now holds both languages:

- `types.ts` — Person 1 imports this
- `agentgate_shared/types.py` — Persons 2 and 3 import this

They are mirrors of each other and **must stay in step**. The wire format is camelCase because
that is what the TypeScript gateway sends; the Python models accept camelCase and expose
snake_case attributes. Change one file, change the other, and tell the team.

---

## Measured latency

Over 29 live evaluations against GPT-4o on a healthy connection:

```
mean 1842ms · p50 1753ms · p95 2740ms · max 3252ms
```

**This is not the ~500ms the project spec assumed.** Plan the demo around it: the "4ms" story
belongs to Person 1's rule engine, and the judge is the considered-opinion story. The lever if
we need the slow path faster is `AGENTGATE_JUDGE_MODEL=gpt-4o-mini` — I have not benchmarked
accuracy on that.

Under a degraded connection I measured p95 above 15s, at which point the circuit breaker opens
and everything escalates for 30s. That is deliberate — a firewall that cannot judge should not
allow — but if the venue wifi is bad during judging, expect escalations and say so rather than
being surprised.

---

## Cloudflare (Person 1's hours 16–20)

The engine talks only to two interfaces, both in-memory by default. Implement them against
Vectorize and D1 and call `configure_stores` once at boot; nothing in the pipeline changes.

```python
from agentgate_engine import configure_stores, VectorRecord, VectorMatch, SessionState

class VectorizeStore:
    async def upsert(self, records: list[VectorRecord]) -> None: ...
    async def query(self, vector: list[float], top_k: int) -> list[VectorMatch]: ...
    async def size(self) -> int: ...

class D1SessionStore:
    async def get(self, session_id: str) -> SessionState: ...
    async def save(self, state: SessionState) -> None: ...
    async def reset(self) -> None: ...

configure_stores(vectors=VectorizeStore(), sessions=D1SessionStore())
await warmup()
```

Note the engine is Python, so it does **not** run on Cloudflare Workers. It needs a container or
a Python host; the Worker gateway calls it over HTTP. If everything must live on Workers, that
is a conversation to have before hour 16, not at hour 18.

Two practical notes: `warmup()` re-embeds all 19 policies on every cold start, so gate it on
`await vectors.size() == 0`; and in-memory session state does not survive a restart, so
cumulative detection resets with the process.

---

## Environment

Only `OPENAI_API_KEY` is required, read from the repo-root `.env`. LangFuse keys are optional —
tracing no-ops without them.

Tuning knobs, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENTGATE_JUDGE_MODEL` | `gpt-4o` | the risk judge |
| `AGENTGATE_CLASSIFIER_MODEL` | `gpt-4o-mini` | the classifier |
| `AGENTGATE_SESSION_SPEND_LIMIT` | `5000` | cumulative spend trigger |
| `AGENTGATE_ALLOW_BELOW` / `AGENTGATE_BLOCK_AT` | `30` / `70` | decision thresholds |
| `AGENTGATE_JUDGE_TIMEOUT_MS` | `25000` | per-call judge budget |
| `AGENTGATE_REPEATED_CALL_LIMIT` | `10` | loop detection |

---

## Other endpoints

| Endpoint | Use |
| --- | --- |
| `GET /health` | liveness, config, running decision counts |
| `GET /policies` | the 19 policies — feeds the dashboard's policy editor |
| `GET /sessions/{id}` | live cumulative state: spend so far, action counts |
| `POST /sessions/reset` | clear cumulative state between demo runs |
