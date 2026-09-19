# AgentGate — working notes

Read this first. It is the orientation for a fresh session; the detail lives in
`P3_STATUS.md` (this branch) and `SHARED_CONTEXT.md` (on `main`).

## What this is

Hack the North 2026 project. AgentGate is a runtime interception layer between
an AI agent and the tools it calls: every tool call is intercepted, evaluated
(allow / block / escalate), then forwarded or refused.

```
AI agent → MCP gateway (P1) → evaluate() engine (P2) → decision → forward to real tool OR block
                                                          ↓
                                                    action log → dashboard
```

## I am Person 3. Scope — build ONLY these

`packages/demo-agents`, `packages/evals`, `packages/observability`.

**Do NOT build or edit:** the MCP gateway (`packages/gateway`, P1), the LangGraph
judge / RAG / pattern detector (`packages/engine`, P2), or the Next.js dashboard.
If one is needed, make a thin local stub in a P3 package with a
`// TODO: replace with real import from engine` note. Do not change
`shared-types` without asking the user first.

Prefer the simplest thing that works. No speculative scaffolding. If a task
balloons past its obvious scope, stop and ask.

## Branch model — easy to get wrong

- **Code → `person3`.** This is the working branch and where everything below runs.
- **`SHARED_CONTEXT.md` → `main` only.** It is the team's doc; teammates pull it
  without merging P3 code. It is *not* present on `person3` — to read it:
  `git show main:SHARED_CONTEXT.md`. To edit it, check out `main`, edit, commit,
  and check `person3` back out.
- Only ever touch the `## Person 3` section and append to the `## Decisions Log`
  (append-only — never edit another person's line).
- There is **no git remote**. Nothing has been pushed. Ask before adding one.
- Never force-push. Small, frequent commits.

## Commands

```bash
npm install                                   # root, npm workspaces
npm run doctor                                # version-drift check (node + SDK majors)

npm run smoke   -w @agentgate/demo-agents     # 3 mock MCP servers over stdio
npm run agent   -w @agentgate/demo-agents -- --agent=coding --mode=dangerous
npm run eval    -w @agentgate/evals           # 100 scenarios, stub engine
npm run verify  -w @agentgate/observability   # proves Sentry+LangFuse emit (local collector)
npm run verify:judge -w @agentgate/evals      # proves judge wiring (mock providers, no API spend)
```

Typecheck everything:
`for p in shared-types observability evals demo-agents; do npx tsc -p packages/$p/tsconfig.json --noEmit; done`

## Gotchas that have already cost time

- **Sentry gzips envelopes** past a size threshold. A local collector that reads
  the body as utf8 silently sees garbage and reports zero spans/logs while the
  app is emitting correctly. Gunzip when `content-encoding: gzip`.
- **The OpenAI SDK retries twice internally by default.** Combined with our own
  retry policy that is up to 8 requests per scenario, so the client is pinned to
  `maxRetries: 0`. Keep it that way.
- **`@google/genai` v2 declares `node >= 20`** and we run Node 18.20.5. It works,
  but it is an unsupported runtime. `engine-strict` is deliberately **off** in
  `.npmrc` because turning it on blocks `npm install` for the whole team.
- **Workspace `node_modules`**: deps are not always hoisted to the root, and most
  modern packages' `exports` maps refuse `require('pkg/package.json')`. Read
  package.json off disk instead (see `scripts/doctor.mjs`).
- **Only `--model=engine` produces a number that may be called AgentGate's
  score.** Everything else is an eval-engineering artifact and prints a
  `NOT A PRODUCT NUMBER` banner. Do not quote those numbers anywhere.
- Scratch scripts must end in `.mjs` to run as ESM from `node`, and a `tsx`
  entrypoint must sit under a package's `src/` to be treated as ESM.

## Honesty rules for this project

- Never report a mock/local-collector result as live verification. If a key is
  missing, say the step was skipped.
- `invalid` (schema non-conformance) and `skipped` (rate limit / timeout) are
  tracked separately from decisions and never counted as wrong answers.
- Label a model comparison only with the exact model ids that ran.
