# AgentGate

**The firewall between your AI agents and the real world.**

AI agents send email, move money, run commands and query production databases.
Almost nothing sits between the agent and those tools to stop a bad action
*before* it happens. Guardrails validate text. Tracing tells you what already
went wrong. AgentGate refuses the action.

Every tool call passes through AgentGate first and comes back **allowed**,
**blocked**, or **held for a human** — with a written reason citing the policy
it violated.

```
agent: "email the customer their account details"
                    │
             AgentGate
                    │
   BLOCKED  risk 95/100  ·  0.26ms  ·  rule engine, no model call
   PII detected: SSN in "body" — a Social Security number may never
   leave the organisation.
```

---

## Run the whole thing

```bash
cp .env.example .env     # OPENAI_API_KEY is the only required value
npm install
./demo.sh
```

One command. It starts the engine, the gateway and the dashboard, health-checks
each, and prints what to open. `Ctrl-C` stops everything; `./demo.sh down` if it
detached.

```
✔ engine up on :8000
✔ 27 policies · retrieval hybrid · vectors vectorize:agentgate-policies
✔ gateway up on :8787 (MCP proxy + action feed collector)
✔ audit log: D1 4d29b4a2 (durable)
✔ dashboard up on :3100 (live mode)
✔ benchmark: 72.3% (engine(judge=gpt-4o))
```

Then open **http://localhost:3100/live**.

> The engine needs a Python venv the first time:
> `cd packages/engine && ./setup.sh`

### Drive it

```bash
./fire.sh support      # PII exfiltration  → BLOCK on the fast path
./fire.sh coding       # DROP TABLE, rm -rf → BLOCK, no model call
./fire.sh cumulative   # 14 legal $400 payments → ESCALATE at $5,200
./fire.sh all          # the three scenes, in demo order
```

Or type at the agents yourself on `/live`.

---

## The dashboard

| Route | What it is |
| --- | --- |
| **`/live`** | Three production agents in a terminal. Type anything; every call is really evaluated. |
| `/` | **The Shield** — live feed of every gated action |
| `/analytics` | Live operations, LangFuse pipeline telemetry, the benchmark |
| `/review` | Escalations waiting on a human |
| `/policies` | The policy corpus — and publish a new one in plain English or from a document |
| `/present` | Opener: problem, mechanism, measurement |

---

## How it works

Two tiers, two speeds. Deterministic rules catch the obvious things in about a
millisecond. Everything ambiguous goes to a reasoning pipeline that costs about
two seconds and actually thinks.

```
                    ┌ Rule engine ──────────────┐
             fast ↗ │ PII · destructive · ~1ms  │ ↘
┌Proxy┐ ┌Router┐    └───────────────────────────┘  ┌Decision┐  ● Allowed
│MCP· │→│fast  │    ┌ EVALUATION PIPELINE ──────┐ →│+ reason│→ ● Held
│HTTP │ │or    │ ↘  │ Classifier        4o-mini │ ↗└────────┘  ● Blocked
└─────┘ │full  │    │ Policy retrieval  Vec+BM25│
        └──────┘    │ Risk judge        4o·guard│
                    │ Decision gate     threshld│
                    │ Pattern detector  cumul.  │
                    └───────────────────────────┘
```

Each stage degrades rather than failing. The bias never changes: **a firewall
that cannot judge must not allow.**

### What no single-action check can catch

Thirty $400 purchases are thirty legal transactions and one fraud. Verified, and
deterministic:

```
● #1    $400  ALLOW  risk 0        ● #13  $5,200  ALLOW  risk 0
  …eleven more, every one under the $500 limit…
▲ #14  $5,600  ESCALATE  risk 75

  Cumulative Spending Limit: $5,200 across 14 actions this session
  exceeds the limit of $5,000. Pattern: approval-threshold splitting.
```

---

## Two ways to install it

**1 · MCP gateway.** Point the agent at AgentGate instead of at its tools. It
mirrors the upstream server, so the agent sees the same tools it always had —
and never holds a credential for them, so it cannot route around the firewall.

```bash
npm run mcp -w packages/gateway -- --config
```

Merge into `~/Library/Application Support/Claude/claude_desktop_config.json`,
⌘Q, reopen. Works the same for Cursor, Codex, Windsurf and Zed. See
[gateway/MCP.md](packages/gateway/MCP.md).

**2 · Internal systems.** One `POST /evaluate` before you execute, from any
language. The three agents on `/live` run this way.

---

## Policies are the product

26 default policies ship as markdown, but they are **configuration, not code**.

`/policies` takes a rule in plain English, or a `.txt`, `.md`, `.pdf` or
`.docx`. A document containing several rules becomes several policies. Each is
rewritten into the engine's format, validated, stored in D1 and embedded into
Vectorize — retrievable by the judge on the **next tool call**. No deploy, no
restart.

```
You type:   "Agents must never transfer crypto to an external wallet
             without treasury sign-off."

Seconds later:
  transfer_crypto_wallet → BLOCK · risk 100 · Cryptocurrency Transfer Approval
  retrieved: Cryptocurrency Transfer Approval 0.79
```

Submissions that state a *fact* about the organisation rather than a rule
("we are a healthcare provider in Ontario") are stored as context entries —
embedded and retrievable, worded so the judge cannot mistake a fact for a
prohibition.

**Cumulative limits are declared the same way.** A bank counts dollars, a
hospital counts patient records, a SaaS company counts exported rows.

```markdown
Enforced by: pattern_detector
Accumulate: sum(toolArgs.amount)
Applies to: financial
Limit: $5,000
When exceeded: escalate
```

---

## Measured, not claimed

```
rule engine      0.26 – 2ms       no model call, no cost
engine pipeline  mean 1485ms · p50 1476ms · p95 1793ms
tests            87 engine · 108/108 gateway
benchmark        112 labelled scenarios, --model=engine, gpt-4o judge
```

**Accuracy 72.3%, macro-F1 0.654.**

| class | recall | precision |
| --- | --- | --- |
| block | **100%** | 56.3% |
| allow | 97.5% | 95.1% |
| escalate | **16.7%** | 85.7% |

**It does not miss threats** — block recall is 100%. The losses are over-refusal
of cases the labels call escalations, and most trace to an unresolved
disagreement about spending thresholds: the scenarios assume a $10,000 limit,
the engine and the demo use $500 and $5,000. Neither set of numbers satisfies
the current labels. That number is honest and not yet good.

A regression gate refuses to promote a worse run. A re-run on 2026-09-20 scored
67.3% and was written to `report.failed.json` rather than becoming the baseline.

`/analytics` reads the report from disk per request — re-run the harness and the
page updates within ten seconds, no rebuild:

```bash
npm run eval -w @agentgate/evals -- --model=engine
# add --update-baseline only if it beats the current number
```

**Only `--model=engine` produces a number that may be called AgentGate's score.**
Everything else prints a `NOT A PRODUCT NUMBER` banner.

---

## What is live

| | |
| --- | --- |
| **OpenAI** | gpt-4o judge, gpt-4o-mini classifier, text-embedding-3-small |
| **Cloudflare Vectorize** | policy vectors — live, in-memory mirror covers write lag |
| **Cloudflare D1** | policies, sessions and the action log — live, durable |
| **LangFuse** | one trace per evaluation, a span per node — read back onto `/analytics` |
| **Sentry** | errors and tracing on the gateway |
| **Zip** | MCP proxy in front of `ziphq-mcp`, plus live budget/vendor grounding |

Both Cloudflare stores fail soft: unreachable means falling back to memory, and
`GET /health` reports which is actually in use, so a silent fallback cannot be
mistaken for success.

Nothing the dashboard shows is lost on restart. Verified by killing the gateway
mid-session: 19 feed rows before, 19 after.

---

## Layout

| package | language | what |
| --- | --- | --- |
| `gateway` | TypeScript | MCP proxy, 5 rules, D1 audit log, Cloudflare Worker, Sentry |
| `engine` | Python | LangGraph judge, RAG, policy admin, pattern detector |
| `evals` | TypeScript | 112-scenario harness, regression gate, DeepEval cross-check |
| `demo-agents` | TypeScript | three MCP tool servers, nine tools |
| `observability` | TypeScript | Sentry and LangFuse wiring |
| `apps/dashboard` | TypeScript | the control plane and the live stage |

---

## TODO before submission

- [ ] **Zip** — attach the sponsor integration to the submission. Built and
      running against the live API ([engine/ZIP.md](packages/engine/ZIP.md));
      `./demo.sh --zip` turns grounding on. It is **off by default** because the
      staging tenant had no vendors, which made every payment a correctly
      refused unapproved payee and pre-empted the cumulative scene. One vendor
      now exists, so re-check whether it can be on for the demo.
- [ ] **Cloudflare** — attach the sponsor integration to the submission. D1 and
      Vectorize are live and verified; the gateway Worker has a `wrangler.jsonc`
      and deploys, the Python engine cannot run on Workers and needs a container
      host. See [engine/DEPLOYMENT.md](packages/engine/DEPLOYMENT.md).
- [ ] Re-run the benchmark after the PII rule change and promote it only if it
      beats 72.3%.
- [ ] Nothing is deployed publicly — the demo runs on a laptop.
- [ ] Resolve the $500 / $10,000 threshold disagreement between the scenario
      labels and the engine config. Ten minutes of conversation is worth more
      than any code here.

Not started: Python SDK `wrap()`, Gemini second opinion, GPTZero, RAGAS,
OpenTelemetry spans, KV caching. The review queue displays escalations but
approve/deny is not wired.

---

## Docs

| | |
| --- | --- |
| [engine/ARCHITECTURE.md](packages/engine/ARCHITECTURE.md) | every flow, and both integration paths |
| [engine/INTEGRATION.md](packages/engine/INTEGRATION.md) | how to call the engine |
| [engine/RUNBOOK.md](packages/engine/RUNBOOK.md) | seeing it work, and troubleshooting |
| [engine/DEPLOYMENT.md](packages/engine/DEPLOYMENT.md) | deployment plan and its one constraint |
| [engine/ZIP.md](packages/engine/ZIP.md) | governing Zip's 131 tools |
| [engine/CSE.md](packages/engine/CSE.md) | the CSE log analyser |
| [gateway/MCP.md](packages/gateway/MCP.md) | connecting Claude Desktop, Cursor, Codex |

---

Built at Hack the North 2026.
