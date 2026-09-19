# AgentGate

The firewall between your AI agents and the real world.

Every action an agent attempts — sending an email, making a purchase, running a
query — passes through AgentGate first. It is evaluated against company policies
and behavioural patterns, then allowed, blocked, or escalated to a human.

---

## Repo layout

| Package | Owner | Language | What it is |
| --- | --- | --- | --- |
| `packages/gateway/` | Person 1 | TypeScript | MCP proxy + rule engine (fast path) |
| `packages/engine/` | Person 2 | **Python** | LLM-as-judge pipeline (slow path) |
| `packages/demo-agents/` | Person 3 | Python | demo bots + eval suite |
| `packages/shared/` | everyone | both | the contract types |
| `apps/dashboard/` | later | TypeScript | control plane UI |

> **This branch (`person2/engine`) currently contains only the engine and the
> shared contract.** It also carries the Phase 0 scaffolding — root
> `package.json`, `.gitignore`, `.env.example` — because Phase 0 was never done
> as a group. Expect root-level conflicts when the three branches merge, and
> reconcile `packages/shared/` first: it is what everything compiles against.

---

## How the pieces connect

```
Person 3's demo agents (Python)
            │  HTTP: POST /evaluate
            ▼
Person 1's gateway (TypeScript, MCP proxy)
            │
            ├── rule engine ── obvious threats blocked in <10ms, no LLM
            │
            └── HTTP: POST localhost:8000/evaluate   ← only if rules didn't decide
                        │
                        ▼
            Person 2's engine (Python + FastAPI)
            classifier → retrieval → judge → gate → patterns
                        │
                        ▼
                  OpenAI · LangFuse
```

Two layers, two speeds. The rule engine catches `DROP TABLE` and raw SSNs
instantly. The engine handles everything ambiguous, and the cumulative patterns
no single-action check can see.

---

## Running the engine

```bash
cd packages/engine
./setup.sh                                   # venv + deps, one time

./venv/bin/pytest -q                         # 29 tests, no API key needed
./venv/bin/python demo.py                    # narrated four-scene walkthrough
./venv/bin/uvicorn server:app --port 8000    # the service Person 1 calls
```

The only required environment variable is `OPENAI_API_KEY` in a root `.env`
(copy `.env.example`). Everything else is optional.

Full docs:

- **[packages/engine/ARCHITECTURE.md](packages/engine/ARCHITECTURE.md)** — flowcharts: how it works and how to connect to it
- **[packages/engine/README.md](packages/engine/README.md)** — design and why
- **[packages/engine/INTEGRATION.md](packages/engine/INTEGRATION.md)** — Person 1 and Person 3, start here
- **[packages/engine/RUNBOOK.md](packages/engine/RUNBOOK.md)** — seeing it work, and troubleshooting
- **[packages/engine/DEPLOYMENT.md](packages/engine/DEPLOYMENT.md)** — deployment plan, **read before hour 16**

---

## The contract

`packages/shared/` holds the same types twice, once per language:

```
types.ts                   ← Person 1 imports this
agentgate_shared/types.py  ← Persons 2 and 3 import this
```

The wire format is **camelCase**, because that is what the TypeScript gateway
sends. The Python models accept camelCase and expose snake_case attributes.

**These two files must stay in step.** Change one, change the other, and tell
the team. This is the most fragile point in the project.

---

## Three things the team needs to know

**Latency is ~1.9s, not ~500ms.** Measured over 29 live evaluations against
GPT-4o: `mean 1914ms · p50 1815ms · p95 2698ms`. The project spec's ~500ms
estimate was optimistic. The "4ms" demo story belongs to Person 1's rule engine;
the engine buys judgement, not speed.

**The engine cannot run on Cloudflare Workers.** It is Python. The Worker
gateway calls it over HTTP instead. See
[DEPLOYMENT.md](packages/engine/DEPLOYMENT.md) — this changes Person 1's hours
16–20 plan and is better discussed now than at 3am.

**Use a stable `sessionId` per agent conversation.** All cumulative detection
keys off it. A fresh id per action means the 30 × $400 demo silently never
fires. This is the most common integration mistake.
