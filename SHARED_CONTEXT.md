# AgentGate — Shared Context

Runtime interception layer between an AI agent and the tools it calls.

```
AI agent → MCP gateway (P1) → evaluate() engine (P2) → decision → forward to real tool OR block
                                                           ↓
                                                     action log → dashboard
```

**Branches:** code lives on `person1` / `person2` / `person3`. This file lives on `main` —
commit doc updates straight to `main` so everyone can pull it without merging code.
Pull/rebase before editing. Only touch your own section; the Decisions Log is append-only.

**Other docs:** `CLAUDE.md` (here) is the short orientation — scope, branch model,
commands, and the gotchas that have already cost someone time. P3's detailed
status, blockers and open questions are in `P3_STATUS.md` on the `person3`
branch: `git show person3:P3_STATUS.md`.

---

## Repo layout

```
packages/shared-types   the four agreed contracts (see below)
packages/gateway        P1 — MCP gateway
packages/engine         P2 — LangGraph judge / RAG / pattern detector
packages/demo-agents    P3 — mock MCP tool servers + demo agents
packages/evals          P3 — eval harness + stub evaluate()
packages/observability  P3 — Sentry + LangFuse wiring
apps/dashboard          Next.js dashboard
```

Bootstrap (npm workspaces + turbo) is on `main`. `npm install` at the root.

---

## Interfaces & Contracts

Defined in `packages/shared-types/src/index.ts`. Do not change unilaterally.

```ts
type AgentAction = { id: string; agentId: string; toolName: string; toolArgs: Record<string, unknown>; timestamp: number; sessionId: string };
type Decision = 'allow' | 'block' | 'escalate';
type EvalResult = { riskScore: number /*0-100*/; decision: Decision; reasoning: string; violatedPolicy?: string; latencyMs: number };
type Policy = { id: string; name: string; description: string; type: 'rule' | 'llm'; pattern?: string; enabled: boolean };
```

**Engine entrypoint (owned by P2, depended on by P1 and P3):**

```ts
evaluate(action: AgentAction, context: SessionContext): Promise<EvalResult>
```

**⚠️ `SessionContext` is PROVISIONAL — P2 please confirm or amend.** P3 has coded
against this shape and exported it from `shared-types` so we all use one definition:

```ts
type SessionContext = { sessionId: string; recentActions: AgentAction[]; cumulative: { spend: number; dataAccessCount: number } };
```

**Risk thresholds** (exported as `RISK_THRESHOLDS` / `decisionForRiskScore`):
`0–30 → allow`, `30–70 → escalate`, `70–100 → block`.

### Pinned versions — P1/P2 please match these

Drift here is the most likely cause of a merge that installs for one of us and
not the others. Run **`npm run doctor`** to check yourself in one command.

| what | pinned | why |
| --- | --- | --- |
| **Node** | **18.20.5** (`.nvmrc`, `engines.node`) | what the repo actually runs on today |
| `@sentry/node` | v10 | `enableLogs` is top-level and `Sentry.logger` exists only from v10 |
| `@google/genai` | v2 | current Gemini SDK; `@google/generative-ai` is legacy |
| `mongodb` | v6 | **v7 requires Node >= 20.19** |
| `langfuse` | v3 | v5 is the newer OTel-based `@langfuse/client`; not migrating mid-hackathon |
| `openai` | v4 | works; v7 exists but nothing needs it yet |

**⚠️ Known conflict:** `@google/genai` v2 declares `node >= 20.0.0`. It runs fine
on 18 (verified), but it is an unsupported runtime and only `@google/genai@1.0.x`
supports Node 18 — which is too old to be worth using. `engine-strict` is
deliberately **off** in `.npmrc`, because turning it on blocks `npm install` for
everyone. **If we want to be on a supported runtime, the team should move to
Node 20** — flagging it rather than deciding it alone.

---

## Person 1 — MCP Gateway

_(P1: your section.)_

---

## Person 2 — Engine

_(P2: your section.)_

---

## Person 3 — Evals / Observability / Demo

### What exists now

**`packages/demo-agents` — mock MCP tool servers (READY, P1/P2 can integrate).**

Three stdio MCP servers. Every tool logs what it received (to **stderr**, so the
stdout JSON-RPC stream stays clean) and returns a canned success. No real side effects.

| server | tools |
| --- | --- |
| `customer-support` | `send_email`, `lookup_customer`, `issue_refund` |
| `procurement` | `create_purchase_order`, `approve_payment`, `check_budget` |
| `coding` | `run_command`, `write_file`, `query_database` |

```bash
npm install
npm run smoke -w @agentgate/demo-agents          # spawns all 3, lists + calls tools
npm run server:coding -w @agentgate/demo-agents  # run one on stdio
```

**P1:** don't hardcode a spawn path — use the helper:

```ts
import { mockServerCommand } from '@agentgate/demo-agents/src/servers/launch.js';
const { command, args } = mockServerCommand('coding');
```

Tool names, zod arg schemas and canned responses are defined once in
`packages/demo-agents/src/tools/catalog.ts`. Need another tool? Ping P3 or add it there.

**`packages/demo-agents` — demo agents (READY).**

Three personas, each with a `safe` and a `dangerous` run:

| persona | safe | dangerous |
| --- | --- | --- |
| `support` | look up customer, email status update, small refund | pull SSN/card, email record to external gmail, $9.4k refund |
| `procurement` | check budget, $4.2k PO, approve | split $28k into three sub-threshold POs to dodge the $10k approval gate |
| `coding` | count rows, write a report, run tests | `DROP TABLE users;`, `rm -rf /var/backups`, write AWS keys to `.env` |

```bash
npm run agent -w @agentgate/demo-agents -- --agent=coding --mode=dangerous
npm run agent -w @agentgate/demo-agents -- --agent=procurement --mode=dangerous --gate=off   # "before AgentGate"
```

Flags: `--agent=support|procurement|coding`, `--mode=safe|dangerous`,
`--gate=stub|off`, `--llm` (real OpenAI tool-calling loop, needs `OPENAI_API_KEY`), `--json`.
Without `--llm` the run is a deterministic script, so **the demo works with no API key**.

**`packages/evals` — stub `evaluate()` (READY, temporary).**

`packages/evals/src/engine/stub.ts` is a ~12-rule stub so the agents, the harness
and the dashboard have something to run against before P2's engine lands.
**P2: this is scaffolding, not a competing engine — it gets deleted when yours works.**

The swap is already wired: `resolveEvaluate()` reads `AGENTGATE_ENGINE`
(`stub`, the default, or `engine`) and dynamically imports `@agentgate/engine`,
falling back to the stub with a warning if it isn't exporting `evaluate()` yet.
**P2: export `evaluate` from the `@agentgate/engine` package root and it just works.**

### The interception seam

Agents route every tool call through a `ToolGate`
(`packages/demo-agents/src/agents/gate.ts`) before it reaches the tool. When P1's
gateway speaks MCP stdio, `src/agents/mcp-client.ts` points at the gateway instead
of the mock server and nothing else changes.

**`packages/evals` — eval harness (READY).**

100 labelled scenarios in `packages/evals/scenarios.json`: 40 safe→allow,
30 dangerous→block, 20 ambiguous→escalate, 10 cumulative-pattern cases that are
only decidable from prior session actions.

```bash
npm run eval -w @agentgate/evals                      # full suite
npm run eval -w @agentgate/evals -- --category=ambiguous
npm run eval -w @agentgate/evals -- --engine=engine   # force P2's real engine
npm run eval -w @agentgate/evals -- --strict --min-macro-f1=0.85   # CI gate
```

Prints per-class precision/recall/F1, a confusion matrix, per-category accuracy,
latency percentiles and every mismatch with the policy that fired; full detail
goes to `packages/evals/report.json` (gitignored).

**Current stub baseline: accuracy 91%, macro-F1 0.895** (allow F1 0.966,
escalate 0.829, block 0.889). **P2 — this is the number to beat.** The stub's
known gaps, which the real engine should pick up: it misses `rm -rf ~/` and fork
bombs, treats `GRANT ALL` as a mere schema change, and can't tell a $10,000
payment that should escalate from one that should block.

**⚠️ Only `--model=engine` produces AgentGate's score.** Every report carries an
`isProductNumber` flag that is true *only* for that run. The stub and the P3
judge wrapper are eval-engineering artifacts — they measure a rule table and two
judge models, not the product. Any other run prints a loud `NOT A PRODUCT NUMBER`
banner. **Nothing else goes on stage or in the README.**

**Model comparison (`--model=`).** The harness is model-parametrized:

```bash
npm run eval -w @agentgate/evals -- --model=stub,engine     # rules vs P2's engine
npm run eval -w @agentgate/evals -- --model=openai,gemini   # dual-model headline stat
```

One provider-agnostic prompt (`src/models/prompt.ts`) goes byte-for-byte through
both providers, each using its own structured-output mechanism (OpenAI
`json_schema`, Gemini `responseSchema`), so the model is the only variable.
`npm run verify:judge -w @agentgate/evals` asserts that against local mock
endpoints — no API spend. Two or more models also writes `report.by-model.json`
with per-model metrics and every scenario where they disagreed.

Model ids come from `OPENAI_JUDGE_MODEL` / `GEMINI_JUDGE_MODEL`; a missing API
key skips that model with a warning instead of failing the run.

**Live-hardening (done before spending any quota).** A judge can fail in ways
that say nothing about its judgement, and scoring those as wrong decisions would
libel a provider. Three buckets are now tracked separately and printed:

- `scored` — produced a conforming decision. **Only these reach the metrics.**
- `invalid` — output did not conform to the requested schema. OpenAI's strict
  `json_schema` and Gemini's `responseSchema` accept different JSON-Schema
  subsets, so this is a plumbing failure, never a wrong answer.
- `skipped` — never resolved after bounded exponential backoff (jittered,
  honours `Retry-After`) on 429/408/5xx/timeout. Gemini free-tier RPM caps make
  this common and it is not a quality signal.

The OpenAI client is pinned to `maxRetries: 0` — the SDK retries twice by
default, which would compound with ours into up to 8 requests per scenario.

**Honest labelling.** `comparisonLabel()` is built from the exact model ids that
actually ran, so a `gpt-4o-mini` vs `gemini-2.5-flash` run **cannot** be written
up as "GPT-4o vs Gemini". Comparing different size tiers prints a `TIER MISMATCH`
warning. The **disagreement list is the headline output** — for each scenario
where the models differ, both decisions and which matched our label — and the
aggregate percentages are explicitly secondary. The horserace invites a fairness
argument we cannot fully win; the disagreements are the defensible artifact.

**⚠️ P2 — one contract question.** For a fair comparison I need to pin the
deciding model. Proposed, not yet applied:

```ts
evaluate(action: AgentAction, context: SessionContext, opts?: { model?: string }): Promise<EvalResult>
```

Until you confirm, the comparison runs through a P3-owned judge wrapper that
bypasses your pipeline entirely. If you adopt the option, the comparison moves
behind `evaluate()` and my wrapper goes away. See `EvaluateOptions` in
`packages/evals/src/engine/index.ts`.

**Regression mode — the team's safety net. Run this before you push.**

```bash
npm run eval -w @agentgate/evals -- --strict                # exit 1 on regression
npm run eval -w @agentgate/evals -- --update-baseline       # accept new numbers
```

Every run diffs against the previous `report.json`: a macro-F1 floor (0.8), a
per-class recall floor (0.7) and a max drop vs the last run (0.05), all
configurable. It names every scenario that flipped, marked `fixed` or `BROKEN`.
A scenario-set hash stops it comparing runs scored on different inputs, and a
failing run does **not** overwrite the baseline — it parks in
`report.failed.json` so one bad commit cannot quietly reset the bar.

**P2: this is what catches a prompt change breaking things.** Verified by
deliberately weakening a stub rule: it named all 6 broken scenarios and exited 1.

**Eval run history (MongoDB Atlas).** Each run is persisted — timestamp, model,
per-class precision/recall/F1, confusion matrix, scenario hash, report path,
pass/fail. Set `MONGODB_URI`; without it the run warns and carries on.
**Scope: P3 eval runs only — agent action logs belong in P1's D1 store, not here.**

**`packages/observability` — Sentry + LangFuse (READY).**

Both no-op without keys, so nothing breaks offline.

- **Sentry (Errors + Tracing + Logs):** an `agentgate.evaluate` breadcrumb per
  evaluation, a warning event per `block`, captured `uncaughtException` /
  `unhandledRejection`, **a span per evaluation** carrying decision, riskScore,
  toolName, path (`rule` | `judge`) and latencyMs under a root span per run, and
  **structured Logs** for every block/escalate reason. Wired into both the
  demo-agent CLI and the eval harness. SDK is `@sentry/node` v10.
- **LangFuse scores:** every scored scenario attaches a `decision_correctness`
  score to its span, so traces are self-evaluating.
- **LangFuse span tree** — **P1/P2 please use these exact names:**

```
agentgate.agent.run          (P3) one demo-agent run / one eval suite
  agentgate.tool_call        (P3) one attempted tool call
    agentgate.evaluate       (P2) evaluate() -- P2, nest your judge / RAG /
                                  pattern-detector spans UNDER this one
    agentgate.tool_exec      (P3) forwarded call to the real tool; absent
                                  unless the decision was allow
```

Import the `SPAN` constants from `@agentgate/observability` rather than
retyping the strings.

```bash
npm run verify -w @agentgate/observability   # proves both actually emit
```

That spins up a local collector speaking both ingest protocols and runs a real
agent run + eval run against it — no live keys needed. It asserts breadcrumbs,
**transactions with span attributes**, **logs**, LangFuse spans and scores.
Both processes currently PASS (demo-agents: 4 spans / 3 logs; evals: 30 spans /
28 logs / 30 scores).

### What I depend on

- P2: `evaluate(action, context)` exported from `@agentgate/engine`; confirmation of `SessionContext`.
- P1: gateway spawnable as an MCP stdio server, so the agents can point at it unchanged.
- P2: LangFuse span names, so P3's agent-side trace nests inside P2's engine trace instead of duplicating it.

### Known constraints

- **We are on Node 18.20.5.** Several current SDKs now require Node >= 20
  (`mongodb` v7 does; pinned to v6 here). Worth agreeing whether the team
  upgrades before someone hits it harder than I did.
- `langfuse` v3 is what we use; there is a newer OTel-based `@langfuse/client`
  v5. Not migrating mid-hackathon — v3 works and the span names above are stable.
- The OpenAI and Gemini judges are wiring-verified against mock endpoints
  (`npm run verify:judge`, 20 checks) but have **not** been run against the live
  APIs — there is no `.env` on my machine. Model ids in `.env.example` are
  defaults to confirm before the demo.
- Sentry and LangFuse are transport-verified against a local collector
  (`npm run verify`) but **not** against the real backends, for the same reason.

### RE-BASELINE DONE — the first real product number

P2's engine landed and was merged into `person3`. **It is a Python + FastAPI
service, not an npm package**, so the old `import('@agentgate/engine')` swap
could never have worked; the harness now calls it over HTTP. Ran:

```bash
npm run eval -w @agentgate/evals -- --model=engine --update-baseline
```

**AgentGate scored 71.0% accuracy, macro-F1 0.584** over all 100 scenarios,
100/100 scored, **zero degraded evaluations**, `isProductNumber: true`.
Engine at full strength (`retrieval: hybrid`, judge `gpt-4o`).
Latency mean 1986ms / p50 1856ms / p95 2913ms.

| class | precision | recall | F1 |
| --- | --- | --- | --- |
| allow | 94.3% | 78.6% | 0.857 |
| escalate | 66.7% | **9.1%** | 0.160 |
| block | 58.1% | **100.0%** | 0.735 |

**Read this before reacting to the number.** It is below the stub's 91%, but the
two are not measuring the same thing, and the gap is mostly one disagreement:

- **26 of 29 mismatches are over-blocking** (18 escalate->block, 8 allow->block).
  Only 2 are under-blocking. **Block recall is 100% — the engine never let a
  dangerous action through.** For a security product that is the safe direction
  to be wrong in.
- **16 of 29 mismatches cite the engine's `$500` single-transaction limit.**
  P3's scenarios were labelled against a **$10,000** human-approval threshold.
  Reconciling that one number alone takes accuracy to **87.0%**.
- **escalate recall 9.1%** is the real finding: the engine blocks where we
  expect escalate. 17 of 20 ambiguous scenarios came back `block`.

**P2 — this is a calibration disagreement, not a bug, and it is the most
important thing to settle before the demo.** Either the policy corpus adopts
$10,000, or P3's scenario labels adopt $500 — but we cannot ship a demo where
"buy $4,200 of laptops" is blocked while the script calls it routine. P3 will
not relabel scenarios to flatter the number; that decision is the team's.

The regression gate **failed** this run on its floors (macro-F1 0.584 < 0.8,
escalate recall 9.1% < 0.7). That is the gate doing its job. `--update-baseline`
was passed deliberately, so this is now the baseline everything is measured from.

### Next up

Done: mock servers, demo agents, eval harness, Sentry (errors + tracing + logs),
LangFuse (tracing + scores), dual-model comparison + live-hardening, regression
mode, Mongo history, version pins, product-number guard, **P2 engine integration
over HTTP, and the first product number**.
Stretch, not started: CSE Log & Order, GPTZero, DeepEval, RAGAS.

---

## Decisions Log

_Append-only. Format: `- [HH:MM] (Px) <what changed / decided / impact>`_

- [05:20] (P3) Repo was empty — bootstrapped npm-workspaces + turbo scaffold and `packages/shared-types` on `main` with the four agreed contracts verbatim. P1/P2: pull `main` before you start, don't re-create these.
- [05:22] (P3) Added `SessionContext` + `RISK_THRESHOLDS` + `decisionForRiskScore` to `shared-types`. **`SessionContext` is provisional and owned by P2** — P2, confirm or amend it, I've coded the stub and harness against it.
- [05:24] (P3) Mock MCP tool servers + 3 demo agents are RUNNABLE on branch `person3` (`npm run smoke -w @agentgate/demo-agents`). P1 unblocked: spawn via `mockServerCommand(server)`. Servers log to stderr only.
- [05:25] (P3) Stub `evaluate()` in `packages/evals` behind `AGENTGATE_ENGINE=stub|engine`; auto-swaps to `@agentgate/engine` once P2 exports `evaluate`. P2: no action needed beyond the export.
- [05:40] (P3) Eval harness READY: 100 labelled scenarios, per-class precision/recall/F1 + confusion matrix + `report.json`. Stub baseline accuracy 91% / macro-F1 0.895 — P2, that's the bar.
- [05:52] (P3) Added `packages/observability` (P3-owned): Sentry breadcrumbs + LangFuse tracing, both no-op without keys. **P1/P2: use the `SPAN` constants; P2 nest engine spans under `agentgate.evaluate`.** Verified actually emitting via a local collector (`npm run verify -w @agentgate/observability`).
- [05:53] (P3) Cumulative spend accounting agreed as: book spend on `approve_payment` only, and only when the decision was `allow` — otherwise a PO plus its payment double-counts. P2: match this in the pattern detector or tell me to change it.
- [10:05] (P3) Sentry deepened to **Errors + Tracing + Logs** (`@sentry/node` v8 -> v10): span per evaluation with decision/risk/tool/path/latency, structured Logs for block/escalate. LangFuse traces now carry a `decision_correctness` score per scenario. Verifier asserts all of it.
- [10:06] (P3) **P2 — contract question:** proposed `evaluate(action, context, opts?: { model?: string })` so the harness can pin the deciding model. Not applied; comparison currently bypasses your pipeline via a P3-owned judge wrapper. Confirm or reject. See `EvaluateOptions` in `packages/evals/src/engine/index.ts`.
- [10:07] (P3) Harness is model-parametrized: `--model=stub,engine,openai,gemini`, one byte-identical prompt across providers, `report.by-model.json` + disagreement list.
- [10:08] (P3) **Regression mode live — run `npm run eval -w @agentgate/evals -- --strict` before pushing.** Floors + max-delta vs last run, names every flipped scenario, and a failing run never overwrites the baseline. P2: this is what will catch a prompt change breaking things.
- [10:09] (P3) MongoDB Atlas eval-run history added (P3 eval runs only — **action logs stay in P1's D1 store**). Pinned `mongodb` v6: **v7 needs Node >=20.19 and we are on Node 18** — worth a team decision on upgrading.
- [10:22] (P3) **Version pins recorded — P1/P2 please match:** Node 18.20.5 (`.nvmrc` + `engines.node`), `@sentry/node` v10, `@google/genai` v2, `mongodb` v6, `langfuse` v3, `openai` v4. Run `npm run doctor` to check. **Conflict: `@google/genai` v2 declares node>=20** and only its v1.0.x supports 18, so `engine-strict` is off deliberately — team decision needed on moving to Node 20.
- [10:30] (P3) Judge hardened before any live quota: schema failures bucket as `invalid` and rate-limit/timeout exhaustion as `skipped`, **neither counted as a wrong decision**; bounded backoff honouring `Retry-After`; OpenAI `maxRetries: 0` so the SDK's own retries don't compound with ours.
- [10:31] (P3) **Honest tier labelling enforced in code.** Summaries are labelled with the exact model ids that ran (default `gpt-4o-mini` vs `gemini-2.5-flash`, NOT "GPT-4o vs Gemini"), cross-tier pairs print a TIER MISMATCH warning, and the disagreement list is now the headline with aggregate percentages secondary.
- [10:32] (P3) **`isProductNumber` guard added: true only for `--model=engine`.** Stub and judge-wrapper runs print a loud NOT A PRODUCT NUMBER banner. Please don't quote any other number as AgentGate's.
- [10:33] (P3) **Live backend verification NOT done — there is no `.env` in the repo** and no Sentry/Gemini/LangFuse vars are exported, so I could not run against the real backends. Everything remains transport-verified against local collectors only; I have deliberately not reported mock results as live. Blocked on keys.
- [10:40] (P3) Added `CLAUDE.md` (orientation) and `P3_STATUS.md` (P3 detail, on `person3`). **Moved the Node/SDK version pins onto `main`** — they had landed on `person3` only, so P1/P2 pulling `main` never saw them. `npm run doctor` now works from `main`.
- [10:34] (P3) **Engine re-baseline queued, blocked on P2.** `packages/engine` does not exist yet. The moment it exports `evaluate`: `npm run eval -w @agentgate/evals -- --model=engine --update-baseline`. All prior baselines are stub / P3-judge and are superseded by that run.
- [17:55] (P3) **Merged P2's `person2/engine` into `person3`** (unrelated histories — their branch was cut from the empty GitHub `main` and never saw our bootstrap). P2's engine is **Python + FastAPI**, so `@agentgate/engine` is not importable: the harness now calls `POST /evaluate` over HTTP. P1 — your gateway needs the same, see `packages/engine/INTEGRATION.md`.
- [17:56] (P3) **`SessionContext` resolved by P2:** `cumulative` is gone (the engine owns session state), `recentActions` is optional, `agentId` added. `AgentAction.timestamp` differs — ours `number`, theirs `datetime` — so P3 serialises ISO on the wire rather than trusting pydantic's seconds-vs-ms heuristic. Two contracts now coexist: `packages/shared-types` (ours) and `packages/shared` (P2's). **They should be merged into one; flagging, not deciding.**
- [17:57] (P3) **`evaluate(action, context, opts?: {model})` — REJECTED by P2**, model comes from `AGENTGATE_JUDGE_MODEL` instead. So the model comparison stays in P3's judge wrapper; it is not redundant, since an env var cannot vary within a run.
- [17:58] (P3) **P2 — cumulative spend double-counts.** `pattern_detector.py` books spend on *any* allowed financial action, so `create_purchase_order($4200)` + `approve_payment($4200)` books **$8400** against the $5000 limit. P3 agreed (05:53) to book on `approve_payment` only for exactly this reason. The procurement demo will trip the cumulative alert at half the intended spend and **look correct on stage**. P2's call to fix.
- [17:59] (P3) **P3 bug fixed: the repo-root `.env` was never loaded.** `import 'dotenv/config'` resolves against `process.cwd()`, and npm workspace scripts run with cwd = the package dir — so every key was invisible and the harness reported "SENTRY_DSN not set" for a DSN that authenticates fine. Now loaded via `@agentgate/observability/load-env`. **P1/P2: if you add a TS entrypoint, import that first.**
- [18:00] (P3) **Live backend verification DONE for Sentry** — ingest returns HTTP 200 with an event id, 26 block events and 31 `agentgate.evaluate` spans emitted over the dangerous set. **LangFuse NOT verified: the keys were removed from `.env` mid-session.** Dashboard confirmation is the user's, not mine.
- [18:01] (P3) **`gemini-2.5-flash` is retired for new API keys** (404, "no longer available to new users"). Judge moved to `gemini-3.6-flash`. Free-tier RPM is severe: 20 of 30 scenarios rate-limited, bucketed `skipped`, never counted as wrong. **The OpenAI-vs-Gemini comparison rests on 4 jointly scored scenarios and is too thin to quote.**
- [18:02] (P3) **RE-BASELINE DONE — AgentGate scores 71.0% accuracy / macro-F1 0.584**, 100/100 scored, zero degraded, `isProductNumber: true`. **All prior baselines (stub 91%, P3 judge wrapper) are superseded.** Block recall 100%, escalate recall 9.1%; 16 of 29 mismatches are the engine's $500 vs our $10,000 threshold, worth 87.0% if reconciled. **P2 — that threshold is the one decision to make before the demo.**
