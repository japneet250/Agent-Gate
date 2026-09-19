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

---

## Repo layout

```
packages/shared-types   the four agreed contracts (see below)
packages/gateway        P1 — MCP gateway
packages/engine         P2 — LangGraph judge / RAG / pattern detector
packages/demo-agents    P3 — mock MCP tool servers + demo agents
packages/evals          P3 — eval harness + stub evaluate()
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

### What I depend on

- P2: `evaluate(action, context)` exported from `@agentgate/engine`; confirmation of `SessionContext`.
- P1: gateway spawnable as an MCP stdio server, so the agents can point at it unchanged.
- P2: LangFuse span names, so P3's agent-side trace nests inside P2's engine trace instead of duplicating it.

### Next up

Eval harness (~100 labelled scenarios, precision/recall/F1, `evals/report.json`),
then Sentry, then LangFuse.

---

## Decisions Log

_Append-only. Format: `- [HH:MM] (Px) <what changed / decided / impact>`_

- [05:20] (P3) Repo was empty — bootstrapped npm-workspaces + turbo scaffold and `packages/shared-types` on `main` with the four agreed contracts verbatim. P1/P2: pull `main` before you start, don't re-create these.
- [05:22] (P3) Added `SessionContext` + `RISK_THRESHOLDS` + `decisionForRiskScore` to `shared-types`. **`SessionContext` is provisional and owned by P2** — P2, confirm or amend it, I've coded the stub and harness against it.
- [05:24] (P3) Mock MCP tool servers + 3 demo agents are RUNNABLE on branch `person3` (`npm run smoke -w @agentgate/demo-agents`). P1 unblocked: spawn via `mockServerCommand(server)`. Servers log to stderr only.
- [05:25] (P3) Stub `evaluate()` in `packages/evals` behind `AGENTGATE_ENGINE=stub|engine`; auto-swaps to `@agentgate/engine` once P2 exports `evaluate`. P2: no action needed beyond the export.
