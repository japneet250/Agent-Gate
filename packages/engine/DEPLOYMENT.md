# Deploying the engine

Read this before hour 16. There is one architectural constraint in it that
changes Person 1's plan, and it is better found now than at 3am.

---

## Cloudflare: what the engine now uses

The engine talks to **Vectorize** (RAG) and **D1** (session state) over their REST
APIs. It does not need to run on Workers to do that.

```bash
# 1. create a D1 database (optional — sessions stay in memory without it)
npx wrangler d1 create agentgate        # prints database_id

# 2. put these in the repo-root .env
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...                # needs Vectorize:Edit and D1:Edit
VECTORIZE_INDEX=agentgate-policies
D1_DATABASE_ID=...

# 3. provision and verify end to end
./venv/bin/python cloudflare_setup.py
```

That creates the Vectorize index, embeds all 21 policies into it, creates the D1
table, and runs one real query and one real write so you know it works before
the demo rather than during it.

**Verified live.** Against a real Cloudflare account the full path works: RAG
served by Vectorize, session state persisted in D1, and the cumulative detector
still firing at exactly transaction #13 with D1 reporting
`totalSpend: 5600.0` across 14 actions.

### One Vectorize behaviour that will confuse you

`GET .../info` returns **`vectorCount: 0` long after vectors are queryable** —
it lagged for minutes in testing while queries returned correct matches the
whole time. Do not use the count to decide whether the index is populated; run
a query instead. `VectorizeStore.is_queryable()` does exactly that, and
`cloudflare_setup.py` polls with it.

Upserts are also eventually consistent — for a few seconds after a write, a
query legitimately returns nothing. The store mirrors every upsert into memory
and serves from that mirror when Vectorize returns empty, so the lag window
never silently drops retrieval to keyword-only.

`GET /health` then reports what is actually in use:

```json
"storage": { "vectors": "vectorize:agentgate-policies", "sessions": "d1:a1b2c3d4…" }
```

**Both stores fail soft.** If Cloudflare is unreachable the engine falls back to
in-memory and says so in `/health` rather than going down — a firewall that
cannot reach its vector database should still judge. That also means you must
*read* `/health` to know Cloudflare is really being used; the demo will not tell
you, because it works either way.

---

## The constraint

What Cloudflare does *not* do here is run the engine.

**The engine is Python. It cannot run on Cloudflare Workers.** Workers execute
JavaScript and Wasm; there is no CPython runtime. `langgraph`, `openai` and
`pydantic` will not run there.

The project spec assumed a TypeScript engine that Person 1's Worker would import
directly. The new starter guide moved Person 2 to Python and FastAPI, which
makes the engine a separate service by definition. That is fine — it is a
cleaner boundary — but it means **AgentGate is now two deployables, not one.**

```
Person 3's demo agents (Python)
            │  HTTP
            ▼
Person 1's gateway ─── rules (fast path, <10ms) ──► allow / block
  TypeScript          │
  Cloudflare Worker   │ HTTP, only when rules don't decide
                      ▼
           Person 2's engine (Python + FastAPI)
           container host, NOT Workers
                      │
                      ▼
              OpenAI · LangFuse
```

Three ways to resolve it, in the order I'd pick them.

---

## Option A — Worker gateway + hosted Python engine (recommended)

Person 1 keeps the Cloudflare prize. The engine runs on any Python host and the
Worker calls it over HTTPS.

**Pros:** nothing to rewrite; Cloudflare prize intact; each side deploys
independently.
**Cons:** one more service to keep alive; one extra network hop (~50–150ms on
top of the ~1.9s evaluation, so it barely registers).

Hosts that work with zero config, free tier, deploy in minutes:

| Host | How |
| --- | --- |
| **Render** | connect the repo, root `packages/engine`, start command below |
| **Railway** | `railway up` from `packages/engine` |
| **Fly.io** | `fly launch` — uses the Dockerfile below |
| **Google Cloud Run** | `gcloud run deploy --source .` |

Start command for all of them:

```bash
uvicorn server:app --host 0.0.0.0 --port $PORT
```

Set one environment variable: `OPENAI_API_KEY`. Optionally
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`.

Then Person 1 sets `AGENTGATE_ENGINE_URL` in the Worker and points at it instead
of `localhost:8000`.

**Watch out for cold starts.** Free tiers sleep after inactivity and take 20–50s
to wake. Before judging, hit `/health` every few minutes to keep it warm, or run
the engine locally on the demo laptop — see Option C.

---

## Option B — everything local on the demo laptop

What I would actually do for judging. No network dependency beyond OpenAI, no
cold starts, no deploy step.

```bash
# terminal 1
cd packages/engine && ./venv/bin/uvicorn server:app --port 8000

# terminal 2
cd packages/gateway && npm run dev      # points at localhost:8000
```

**Pros:** fastest, most reliable, nothing to go wrong on venue wifi.
**Cons:** no public URL for the Devpost submission, and it doesn't demonstrate
the Cloudflare deployment for the prize.

Do both: deploy Option A for the submission link and the prize, and run Option B
on the laptop for the live demo. They use the same code.

---

## Option C — port the engine to a Worker (not recommended now)

Rewrite the pipeline in TypeScript so everything runs on Workers, with Vectorize
and D1 wired directly. That is the architecture the original spec described, and
the TypeScript implementation still exists in git at commit `4c1cf4a`.

**Only consider this if the team decides the Cloudflare prize requires the whole
system on Workers.** It is a night's work to redo and re-verify, it contradicts
the current starter guide, and the Cloudflare prize criteria do not require
every component to be a Worker — the gateway being one is the point.

---

## Dockerfile

> **Unverified.** This was written but never built — Docker was not available on
> the machine it was authored on. Expect to debug it on first use. The local
> venv path (`./setup.sh`) is verified and is what the demo runs on.

```dockerfile
FROM python:3.12-slim
WORKDIR /app

COPY packages/shared /app/packages/shared
COPY packages/engine /app/packages/engine

RUN pip install --no-cache-dir -r packages/engine/requirements.txt \
 && pip install --no-cache-dir -e packages/shared -e packages/engine

WORKDIR /app/packages/engine
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
```

Build from the **repo root**, not from `packages/engine` — the engine depends on
`packages/shared`:

```bash
docker build -f packages/engine/Dockerfile -t agentgate-engine .
docker run -p 8000:8000 -e OPENAI_API_KEY=sk-... agentgate-engine
```

---

## Before you deploy

- [ ] `OPENAI_API_KEY` is set as an environment variable on the host, **never**
      committed. Rotate the key that has been pasted into chat.
- [ ] `GET /health` returns `"retrieval": "hybrid"`. If it says `keyword-only`,
      the key is missing or embeddings are failing.
- [ ] Person 1's client timeout is **above 25s** — that is the engine's internal
      judge timeout. A shorter client timeout turns good decisions into
      needless escalations.
- [ ] CORS currently allows all origins. Fine for a hackathon on localhost;
      tighten `allow_origins` in `server.py` before this is ever public.
- [ ] Nothing authenticates the engine. Anyone who can reach it can spend your
      OpenAI credit. Keep it on localhost, or put it behind a shared header
      secret if it gets a public URL.

---

## What persists, and what doesn't

Session state is **in memory**. A restart clears it, which means cumulative
spend detection resets. For the demo that is harmless — you reset between runs
anyway with `POST /sessions/reset`.

It matters in two cases: if the host sleeps and wakes mid-demo, and if the
engine is ever scaled to more than one instance, where two replicas would each
see half a session and neither would reach the $5,000 threshold. **Run one
instance.** If that ever needs to change, `configure_stores()` is the seam —
implement `SessionStore` against D1, Durable Objects or Redis and nothing else
changes.

The policy index re-embeds all 19 policies on every cold start, roughly one
second and a fraction of a cent. Harmless as is; gate `warmup()` on
`await vectors.size() == 0` if it ever moves to a persistent vector store.

---

## Deploy order on the day

1. Engine first, to a host from Option A. Confirm `/health`.
2. Person 1 sets `AGENTGATE_ENGINE_URL` and deploys the Worker.
3. Run `demo.py --http` against the deployed engine — same four scenes, over the
   real network. If that passes, the integration is genuinely live.
4. Person 3 points the eval suite at the deployed URL and runs the benchmark.
5. Keep the local setup working as the demo fallback.
