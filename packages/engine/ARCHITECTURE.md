# AgentGate Engine — architecture and integration

How the engine works, and how Person 1 and Person 3 connect to it.

Everything below reflects the code as committed. Diagrams render on GitHub.

---

## 1. Where the engine sits

```mermaid
flowchart LR
    subgraph P3["Person 3 — demo agents (Python)"]
        BOT["support · procurement · coding bots"]
    end

    subgraph P1["Person 1 — gateway (TypeScript, MCP proxy)"]
        MCP["MCP server<br/>intercepts tool calls"]
        RULES{"rule engine<br/>&lt;10ms, no LLM"}
    end

    subgraph P2["Person 2 — engine (Python + FastAPI)"]
        API["POST /evaluate"]
        PIPE["5-node pipeline"]
    end

    subgraph EXT["external"]
        OAI["OpenAI<br/>gpt-4o · gpt-4o-mini · embeddings"]
        CF["Cloudflare<br/>Vectorize · D1"]
        LF["LangFuse"]
    end

    TOOL["real tool / API"]

    BOT -->|tool call| MCP
    MCP --> RULES
    RULES -->|"matched — obvious threat"| VERDICT
    RULES -->|"no match — needs judgement"| API
    API --> PIPE
    PIPE --> OAI
    PIPE -.-> CF
    PIPE -.-> LF
    PIPE -->|EvalResult| VERDICT{"allow / block / escalate"}
    VERDICT -->|allow| TOOL
    VERDICT -->|block| BLOCKED["refused + logged"]
    VERDICT -->|escalate| HUMAN["human review queue"]
```

**Two layers, two speeds.** Person 1's rules kill `DROP TABLE` and raw SSNs in under 10ms with
no API cost. The engine handles everything ambiguous — and the cumulative patterns no
single-action check can see.

The engine **returns a judgement and enforces nothing.** Blocking, forwarding and the review
queue are the gateway's job.

---

## 2. The pipeline

```mermaid
flowchart TD
    IN["AgentAction<br/>tool name + args + sessionId"] --> C

    C["1 · classifier<br/><i>gpt-4o-mini</i>"] -->|category| R
    C -.->|"model down"| CH["regex heuristic<br/>reads before money words"]
    CH -.-> R

    R["2 · policy_retriever<br/><i>hybrid search</i>"] -->|"top-5 policies"| J
    R -.->|"embeddings down"| RK["keyword-only"]
    RK -.-> J

    J["3 · risk_judge<br/><i>gpt-4o, function calling</i>"] --> GR
    J -.->|"judge down"| JF["risk 50 · degraded"]

    GR["guardrails<br/>clamp · grounding"] --> G
    JF -.-> G

    G{"4 · decision_gate<br/>pure thresholds"}
    G -->|"&lt; 30"| A["allow"]
    G -->|"30–69"| E["escalate"]
    G -->|"≥ 70"| B["block"]

    A --> P
    E --> P
    B --> P

    P["5 · pattern_detector<br/>cumulative state"] --> OUT["EvalResult"]
    P -.->|"can only tighten"| OVR["allow → escalate"]
    OVR --> OUT
```

| Node | Does | Model | Can it change the decision? |
| --- | --- | --- | --- |
| `classifier` | labels the action | gpt-4o-mini | no — routes retrieval |
| `policy_retriever` | finds the 5 relevant policies | embeddings | no — supplies evidence |
| `risk_judge` | scores 0–100 + reasoning | gpt-4o | yes — sets the score |
| `decision_gate` | score → decision | none | yes — pure thresholds |
| `pattern_detector` | cumulative checks | none | **only stricter, never looser** |

---

## 3. One request, end to end

```mermaid
sequenceDiagram
    participant GW as Gateway (TS)
    participant API as FastAPI
    participant S as SessionStore
    participant CL as classifier
    participant RT as retriever
    participant JG as judge
    participant PD as pattern_detector

    GW->>API: POST /evaluate {action, context}
    API->>S: get(sessionId)
    S-->>API: totals + last 10 actions

    Note over API: totals and history go into the prompt<br/>so the judge does not guess

    API->>CL: classify
    CL-->>API: "financial" (0.95)
    API->>RT: retrieve for category
    RT-->>API: top-5 policies
    API->>JG: action + policies + totals
    JG-->>API: risk 0, reasoning
    Note over API: guardrails run on the judge's own output
    API->>API: decision_gate → allow
    API->>PD: check cumulative
    PD->>S: save (spend += $400)
    PD-->>API: total $5,200 > $5,000 → escalate
    API-->>GW: {decision:"escalate", riskScore:75, …}
```

The last two steps are the demo moment: the judge says **allow** on the individual $400 order
and is right to; the detector overrides to **escalate** because the session total just crossed
the limit.

---

## 4. Retrieval (the RAG path)

```mermaid
flowchart LR
    ACT["tool args<br/><code>body: 123-45-6789</code>"] --> EN

    EN["enrich.py<br/>detect entity shapes"] --> Q
    EN -.- NOTE["a raw SSN shares no words<br/>with 'personally identifiable<br/>information' — so name it"]

    Q["query text<br/>+ 'social security number…'"] --> EMB
    Q --> KW

    EMB["embed<br/><i>text-embedding-3-small</i>"] --> VS
    VS[("Vectorize<br/>or memory")] --> DENSE["cosine"]
    KW["token overlap"] --> SPARSE["BM25-ish"]

    DENSE --> BLEND
    SPARSE --> BLEND
    CAT["category boost<br/>+0.15"] --> BLEND

    BLEND["0.7·dense + 0.3·sparse + boost"] --> TOP["top 5"]
    TOP --> FILTER{"enforced_by"}
    FILTER -->|judge| TOJ["→ risk_judge"]
    FILTER -->|pattern_detector| HIDE["hidden from judge"]
```

**Why cumulative policies are hidden from the judge.** Shown the *Cumulative Spending Limit*
policy, the judge sees a total "approaching" a threshold it can only guess at and escalates
early — measured firing at transaction 3, 7, 9 and 12 across runs. The detector holds exact
counts and fires at 13 every time. The policies are still retrieved and reported; they are just
not the judge's to apply.

Enrichment moved *PII Protection* from rank 2 to **rank 1** for an SSN-bearing email that never
says "PII" — and kept it at rank 1 in a live run where embeddings failed entirely.

---

## 5. Failure behaviour

```mermaid
flowchart TD
    F{"what failed?"}
    F -->|no API key| E1["risk 50 → escalate"]
    F -->|classifier| E2["regex heuristic<br/><i>continues</i>"]
    F -->|embeddings| E3["keyword-only retrieval<br/><i>continues</i>"]
    F -->|judge| E4["risk 50 → escalate"]
    F -->|"3 failures in a row"| E5["circuit opens 30s<br/>fail fast"]
    F -->|anything else| E6["risk 50 → escalate"]

    E1 --> D["degraded: true"]
    E4 --> D
    E5 --> D
    E6 --> D
    E2 --> D
    E3 --> D
    D --> R["EvalResult returned"]
```

**`evaluate()` never raises.** Every path returns a result. The bias is always the same: *a
firewall that cannot judge must not allow.*

`degraded: true` on the response means a node fell back — worth a badge in the dashboard.

---

## 6. Storage seams

```mermaid
flowchart LR
    P["pipeline"] --> VI["VectorStore<br/><i>protocol</i>"]
    P --> SI["SessionStore<br/><i>protocol</i>"]

    VI --> MV["MemoryVectorStore<br/><b>default</b>"]
    VI --> CV["VectorizeStore<br/>REST"]
    SI --> MS["MemorySessionStore<br/><b>default</b>"]
    SI --> CD["D1SessionStore<br/>REST"]

    CV -.->|"unreachable"| MV
    CD -.->|"unreachable"| MS
```

The pipeline only ever sees the protocols, so switching to Cloudflare is one call:

```python
from agentgate_engine import configure_cloudflare_stores
await configure_cloudflare_stores()      # no-op without credentials
```

Both Cloudflare stores **fail soft** — unreachable means fall back to memory, not go down.
`GET /health` reports what is actually in use, so a silent fallback cannot be mistaken for
success:

```json
"storage": { "vectors": "vectorize:agentgate-policies", "sessions": "d1:a1b2c3d4…" }
```

---

## 7. Connecting — Person 1 (TypeScript gateway)

```mermaid
flowchart TD
    T["tool call arrives"] --> W["wrap as AgentAction"]
    W --> RU{"rules match?"}
    RU -->|yes| FAST["decide now<br/>&lt;10ms, no cost"]
    RU -->|no| HTTP["POST localhost:8000/evaluate"]
    HTTP --> OK{"HTTP ok?"}
    OK -->|yes| USE["use decision"]
    OK -->|"no / timeout"| SAFE["treat as escalate"]
```

**Step 1 — start the engine.**

```bash
cd packages/engine && ./setup.sh
./venv/bin/uvicorn server:app --port 8000
curl -s localhost:8000/health        # expect "retrieval": "hybrid"
```

**Step 2 — call it, but only when your rules didn't decide.**

```ts
import type { AgentAction, EvalResult } from '@agentgate/shared';

const ENGINE = process.env.AGENTGATE_ENGINE_URL ?? 'http://localhost:8000';

export async function judge(
  action: AgentAction,
  sessionId: string,
  recentActions?: AgentAction[],
): Promise<EvalResult> {
  try {
    const res = await fetch(`${ENGINE}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, context: { sessionId, recentActions } }),
      signal: AbortSignal.timeout(30_000),   // above the engine's 25s judge budget
    });
    if (!res.ok) throw new Error(`engine ${res.status}`);
    return await res.json();
  } catch (err) {
    // The engine is down. A firewall that cannot judge must not allow.
    return {
      riskScore: 50,
      decision: 'escalate',
      reasoning: `AgentGate engine unreachable (${err}); escalating for human review.`,
      latencyMs: 0,
    };
  }
}
```

**Step 3 — wire it after your rules.**

```ts
const ruled = runRules(action);
if (ruled.matched) return ruled;                  // fast path
return await judge(action, session.id, session.recent);
```

### Three things that will bite you

| | |
| --- | --- |
| **Stable `sessionId`** | All cumulative detection keys off it. A fresh id per action means the 30 × $400 demo silently never fires. Most common integration mistake — I made it myself while testing. |
| **Timeout above 25s** | That's the engine's internal judge budget. A shorter client timeout turns good decisions into needless escalations. |
| **Don't call it for everything** | Two LLM calls + an embedding per request. Let your rules do their job. |

### Response shape

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

The first five fields are exactly the shared `EvalResult`. The rest are for the dashboard.
**An evaluation failure is never an HTTP error** — you get `escalate` with the reason inside.

---

## 8. Connecting — Person 3 (Python agents + evals)

```mermaid
flowchart LR
    subgraph DEMO["demo bots"]
        B["agent"] -->|"HTTP via gateway"| GW["Person 1"]
    end
    subgraph EVAL["eval suite"]
        D["100+ scenarios"] -->|"direct import"| E["evaluate_detailed()"]
        E --> M["precision · recall · RAGAS"]
    end
```

**For demo bots — go through Person 1's gateway**, so you exercise the real path (rules first,
then the engine).

**For evals — import the engine directly.** No service to keep alive, and you get the structured
detail object.

```bash
pip install -e packages/shared -e packages/engine
```

```python
from agentgate_engine import evaluate_detailed, warmup, reset_sessions
from agentgate_shared import AgentAction

await warmup()                      # once — embeds the policy index

for case in scenarios:
    await reset_sessions()          # ← or cumulative state leaks between cases
    detail = await evaluate_detailed(AgentAction(
        agentId="eval", toolName=case["toolName"],
        toolArgs=case["toolArgs"], sessionId=case["id"],
    ))

    detail.result.decision          # vs case["expectedDecision"]
    detail.retrieved_policies       # → RAGAS context_relevancy
    detail.result.reasoning         # → RAGAS faithfulness
    detail.degraded                 # exclude degraded runs from metrics
```

### For cumulative scenarios, reuse one sessionId

```python
await reset_sessions()
for i in range(1, 31):
    d = await evaluate_detailed(AgentAction(
        agentId="proc", toolName="approve_payment",
        toolArgs={"vendor": f"Supplier {i}", "vendorStatus": "approved", "amount": 400},
        sessionId="cumulative-case",          # ← same id every iteration
    ))
```

`vendorStatus` matters: without it the judge is correctly unsure under *Vendor and Payee
Verification* and escalates at an arbitrary transaction. The scenario has to actually say what
it claims.

### Notes for your metrics

- **`tests/mock_openai.py`** is a scriptable fake client — deterministic CI at zero API cost.
  `tests/conftest.py` shows the wiring.
- **Exclude `degraded: true` runs** from precision/recall. Those are infrastructure failures,
  not judgement errors.
- **My `test_live.py` is a smoke test, not a benchmark** — 16 hand-written scenarios. Please
  don't quote its numbers on Devpost. Your dataset is the real measurement.

---

## 9. The shared contract

```mermaid
flowchart LR
    TS["types.ts"] --> GW["gateway (TS)"]
    PY["agentgate_shared/types.py"] --> EN["engine (Python)"]
    PY --> EV["evals (Python)"]
    TS -.->|"must stay in step"| PY
```

`packages/shared/` holds the same types twice, once per language. The wire format is
**camelCase** because that is what the TypeScript gateway sends; the pydantic models accept
camelCase and expose snake_case attributes.

**Change one, change the other, and tell the team.** This is the most fragile point in the
project.

---

## 10. Quick reference

| Endpoint | Use |
| --- | --- |
| `POST /evaluate` | the one Person 1 calls |
| `POST /judge/evaluate` | same handler, distinct name for logs |
| `GET /health` | liveness, config, storage backend, decision counts |
| `GET /policies` | all 21 — feeds the dashboard's policy editor |
| `GET /sessions/{id}` | live cumulative state: spend, action counts |
| `POST /sessions/reset` | clear state between demo runs |
| `GET /docs` | interactive API browser |

| Command | Does |
| --- | --- |
| `./setup.sh` | venv + deps, one time |
| `./venv/bin/pytest -q` | 35 tests, no API key needed |
| `./venv/bin/python demo.py` | narrated four-scene walkthrough |
| `./venv/bin/python demo.py --http` | same, driving the running service |
| `./venv/bin/python test_live.py` | 18 live scenarios against GPT-4o |
| `./venv/bin/python cloudflare_setup.py` | provision + verify Vectorize and D1 |
| `uvicorn server:app --port 8000` | the service |

See also: [README](README.md) · [INTEGRATION](INTEGRATION.md) · [RUNBOOK](RUNBOOK.md) ·
[DEPLOYMENT](DEPLOYMENT.md)
