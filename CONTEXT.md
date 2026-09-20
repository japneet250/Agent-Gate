# CONTEXT — where this actually stands

Orientation for a session picking this up cold. Written 2026-09-20.

There are already three other notes: `CLAUDE.md` and `P3_STATUS.md` (Person 3's),
`PROGRESS.md` (Person 1's), `SHARED_CONTEXT.md` (team). This one does not repeat
them. It carries the **verified state**, the **decisions and why**, and the
**things that cost hours** — the parts that are expensive to rediscover.

---

## What is true right now

Everything below was run, not remembered.

```
branch            main @ 49cb0f1
engine tests      87 pass (offline, no API key, ~1s)
gateway tests     108/108
typecheck         all six TS packages clean
policies          26 shipped + runtime CRUD, persisted in D1
```

**Working end to end:** an MCP client → gateway (5 rules, ~1ms) → engine (judge,
~2s) → real tool server, with decisions landing in a dashboard at
`localhost:3100`.

**Live third-party services:** OpenAI (gpt-4o judge, gpt-4o-mini classifier,
text-embedding-3-small), Cloudflare Vectorize (policy vectors), Cloudflare D1
(session state + policies + action logs), LangFuse (US region), Sentry, Zip
(staging).

---

## Run it

Four terminals. From the repo root — `npm -w` only resolves workspaces there.

```bash
# 1  engine
cd packages/engine && ./venv/bin/uvicorn server:app --port 8000

# 2  gateway in front of a real tool server
export AGENTGATE_ENGINE_URL=http://localhost:8000/evaluate
export AGENTGATE_ENGINE_KEY="$(grep AGENTGATE_API_KEY .env | cut -d= -f2)"
export AGENTGATE_HTTP_PORT=8787
npm run mcp -w packages/gateway -- customer-support     # or procurement | coding | zip

# 3  dashboard
cd apps/dashboard && NEXT_PUBLIC_DATA_MODE=live \
  AGENTGATE_API_KEY="$(grep AGENTGATE_API_KEY ../../.env | cut -d= -f2)" npm run dev

# 4  make something happen
npx tsx packages/demo-agents/src/agents/cli.ts
```

Useful single commands:

```bash
cd packages/engine
./venv/bin/pytest -q                              # 87 tests, free, no network
./venv/bin/python verify.py                       # 21 live checks, ~20c
./venv/bin/python -m agentgate_engine.redteam     # 98 boundary probes
./venv/bin/python demo.py                         # narrated four-scene walkthrough
```

---

## Things that cost hours. Do not rediscover them.

**Zip's auth header is `Zip-Api-Key`, not `Authorization: Bearer`.** With Bearer
the API replies `{"message":"The provided API key is not valid"}` — which
accuses the key when the header is at fault. The key was fine the whole time.

**Zip's base is `staging-api.zip.com`.** `api.ziphq.com` is production and
answers the same "Welcome to Zip API!" banner, so probing it looks like progress.

**`GET /budgets` on Zip returns 405** (`Allow: OPTIONS, PUT`). Budget state is
only reachable through their MCP server as `zip_search_budgets`. The REST client
notices the 405 once and stops asking.

**The MCP SDK's stdio transport strips the environment.** It forwards only a
safe subset, so a child server comes up unconfigured. `ziphq-mcp` silently
exposed 60 read tools instead of 131 — the 66 destructive ones were simply
absent and nothing looked wrong. Both `upstream.ts` and `mcp-client.ts` now
forward `process.env` explicitly.

**LangFuse Cloud is regional.** This project is on **US**
(`https://us.cloud.langfuse.com`). The EU default 401s with "Invalid
credentials", which reads like a bad key. Three spellings exist in the wild —
`LANGFUSE_BASEURL` (python), `LANGFUSE_BASE_URL` (P3's TS), `LANGFUSE_HOST`.
`.env` sets all three; the engine accepts any.

**Cloudflare Vectorize's `vectorCount` lies.** It reports 0 for minutes after
vectors are queryable. Never gate on it — run a query instead
(`VectorizeStore.is_queryable`). Upserts are eventually consistent, so every
upsert is mirrored in memory and a query that comes back empty is served from
the mirror.

**A real key in `.env` turns the offline suite into a live integration test.**
`ZIP_API_TOKEN` took the engine suite from 1s to 12s by calling Zip on every
financial evaluation. An autouse fixture in `conftest.py` clears it.

---

## Decisions, and why

**Cumulative limits are declared in policy files, not code.** A policy carries
`Accumulate: sum(toolArgs.amount)` / `Limit: $5,000` / `When exceeded:
escalate`. The pattern detector is a generic accumulator over whatever declares
one. This is what makes it a firewall for *any* enterprise rather than one
fictional company — a hospital counts patient records with the same machinery,
by adding a markdown file. `POST /policies/reload` makes it live without a
restart.

**Cumulative policies are hidden from the judge.** Shown the *Cumulative
Spending Limit* policy, the judge escalates on totals "approaching" a threshold
it can only guess at — measured firing at transaction 3, 7, 9 and 12 across
runs. The detector holds exact counts and fires at 13 every time. The judge is
also not told the limit, for the same reason.

**Ambiguity escalates; a crossed threshold never allows.** If the wording admits
an innocent reading a human could confirm in seconds, that is 30–69. But when a
policy names a number and the action crosses it, there is no ambiguity — such an
action is never 0–29. The first attempt at this rule was too broad and *allowed
a 200-record export* against a 100-record policy. False negatives are the worst
failure a firewall has.

**Everything degrades, nothing throws.** `evaluate()` never raises. Classifier
down → regex. Embeddings down → keyword. Judge down → risk 50, escalate. Three
failures → circuit opens for 30s. The bias never changes: **a firewall that
cannot judge must not allow.**

**The action feed carries argument names, never values.** A blocked call's
arguments are the SSN that got it blocked. Sentry's `beforeSend` strips request
and user for the same reason.

**`/actions` answers 501 when unconfigured, not `[]`.** An empty feed and an
unwired feed look identical on screen.

---

## Not done

**No Python SDK.** `from agentgate import wrap` — the only Phase 1 item missing.

**Not deployed.** The engine runs locally behind a Cloudflare tunnel. It is
Python, so it **cannot** run on Workers — the Worker gateway calls it over HTTP
and the engine needs a container host. See `packages/engine/DEPLOYMENT.md`. The
Dockerfile is written but has never been built.

**Escalation is a dead end.** `/review` renders; nothing writes an approval back.

**Zip budget grounding.** Vendor and approval facts work. Budget needs the MCP
path, and it is the strongest half of that prize story.

**Gemini, GPTZero, RAGAS, KV, OpenTelemetry** — rotation-phase prize extras.
Three are blocked on keys nobody has.

**CSE has only seen synthetic data.** The loader handles Zeek/CSV/JSONL and
keeps unknown columns; expect to add column aliases on first contact with the
real dataset.

---

## The two open risks

**The eval number is stale and low.** Last measured **macro-F1 0.607** against a
97% target. Dangerous actions score 93.3% — it does not miss threats; it
over-refuses things the labels call escalations. Most of that traces to a
threshold disagreement: Person 3's scenarios assume **$10,000**, the engine and
the demo use **$500 / $5,000**.

Tested, not argued: adopting $10,000 moves safe accuracy 75% → 92.5% and
**collapses cumulative detection 70% → 16.7%**. No single threshold satisfies
the current label set. Person 3 has since pushed `RELABELS.md` and a
re-baseline; **nobody has re-run the suite against the real engine since.** Do
not quote a number until someone has.

**Nobody has run the demo end to end with a timer.** Every piece works and the
combinations have been tested, but no full dry run has happened. That is where
things break.

---

## How to check the firewall is still coherent

`python -m agentgate_engine.redteam` — 98 probes whose ground truth comes from
**construction**, not from a label:

- **ladders** move one variable across a boundary; the verdict must never get
  looser as the amount rises
- **pairs** where one action is strictly safer by construction
- **injections** attached to a payload whose verdict is already known
- **repeats** of the identical action in separate sessions

A monotonicity violation is a defect you can point at *without first agreeing
where the threshold belongs* — which is why this survives the argument above.
Last run: **98 evaluations, 0 defects.**

It also prints where every boundary sits, which is a far better artefact for a
judge than a percentage.

---

## Team

Three branches merged into `main`: `aaryan` (P1, gateway), `person3` (P3, evals
and demo agents), `person2/engine` (P2, engine). Phase 0 was never landed
jointly, so each merge carried root-level conflicts.

**The contract exists three times** — `packages/shared/types.ts` (P1),
`packages/shared-types` (P3), `packages/shared/agentgate_shared` (Python). The
first two have already drifted: `timestamp: Date` versus `timestamp: number`.
Not breaking the gateway→engine path, because the pydantic model accepts an ISO
string, epoch seconds and epoch millis. Real between the two TypeScript
packages.

---

## Where to read next

| | |
| --- | --- |
| `README.md` | the product, with flowcharts |
| `packages/engine/ARCHITECTURE.md` | every flow as a diagram, both integration paths |
| `packages/engine/INTEGRATION.md` | calling the engine |
| `packages/engine/RUNBOOK.md` | seeing it work, troubleshooting |
| `packages/engine/DEPLOYMENT.md` | deployment, and the Python-on-Workers constraint |
| `packages/engine/ZIP.md`, `CSE.md`, `REDTEAM.md` | those three, in detail |
| `packages/gateway/MCP.md` | connecting Claude Desktop, Cursor, Codex |
