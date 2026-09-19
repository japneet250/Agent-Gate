# Progress Log

Running log of what we've done on AgentGate (Person 1: the gateway). Newest entries at the bottom.
Everything lives on the `aaryan` branch.

## 2026-09-19

### Repo setup
- Cloned `japneet250/Agent-Gate` to `~/aaryan/Agent-Gate`; created the `aaryan` branch.
- Added the team's starter guide as `docs/STARTER_GUIDE.md`.
- Phase 0 workspace setup: `packages/{gateway,engine,demo-agents,shared}` and `apps/dashboard` (npm workspaces),
  shared types in `packages/shared/types.ts` (`@agentgate/shared`), `.env.example`, `.gitignore`.
- Skipped for now (not needed until hours 16-20): API key signups, Cloudflare hello-world test.

### Hours 1-8: MCP proxy skeleton (`packages/gateway`)
- `src/gateway.ts`: MCP server that mirrors the upstream server's tools. Each tool call is wrapped as an
  `AgentAction`, run through `evaluate()`, then forwarded (allow) or refused with
  "This action was blocked because: ..." (block). Escalate is logged and blocked for now.
  Fails closed: if the evaluator throws, the call is blocked.
- `src/evaluate.ts`: **stub** evaluator that always allows. To be replaced by the rule engine, then Person 2's judge.
- `src/index.ts`: CLI entry. `npm start -w packages/gateway -- <upstream command> [args...]` spawns the real tool
  server and serves the proxy over stdio. Logs go to stderr (stdout is the MCP channel).
- `src/mock-upstream.ts`: tiny fake tool server (`echo`, `lookup_order`) for testing.
- `src/smoke-test.ts`: `npm run smoke -w packages/gateway`. Covers tool listing, allow, block, escalate, the
  `AgentAction` shape, fail-closed, and a real stdio end-to-end run. All passing.

#### Try it with Claude Desktop
Claude Desktop launches servers from `/` with a minimal `PATH`, so the config needs absolute paths and an explicit
`PATH` (an earlier `--import tsx` version of this snippet would fail there). This exact entry was tested under a
simulated bare environment (cwd `/`, minimal env) and works. It wraps `mock-upstream.ts` (tools: `echo`,
`lookup_order`), so nothing gets downloaded and no real files are exposed.

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`, then fully quit and reopen Claude Desktop:

```json
"mcpServers": {
  "agentgate-demo": {
    "command": "/opt/homebrew/bin/node",
    "args": [
      "/Users/aaryanpaiva/aaryan/Agent-Gate/node_modules/tsx/dist/cli.mjs",
      "/Users/aaryanpaiva/aaryan/Agent-Gate/packages/gateway/src/index.ts",
      "/opt/homebrew/bin/node",
      "/Users/aaryanpaiva/aaryan/Agent-Gate/node_modules/tsx/dist/cli.mjs",
      "/Users/aaryanpaiva/aaryan/Agent-Gate/packages/gateway/src/mock-upstream.ts"
    ],
    "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }
  }
}
```
Then ask Claude Desktop to use the `echo` tool. Intercepted calls appear as `[agentgate] intercepted ...` in
`~/Library/Logs/Claude/mcp-server-agentgate-demo.log`.
**Status:** command verified under a simulated Claude Desktop launch. Entry added to the real config on 2026-09-19 (backup at
`claude_desktop_config.json.bak-before-agentgate`); waiting on a Claude Desktop restart to try it in the app.

#### Hour 4-5 checkpoint: passed (2026-09-19)
- Ran the real `claude` CLI with the proxy as its only MCP server (`--mcp-config <file> --strict-mcp-config`, nothing saved).
  It called `echo` through the gateway and got `echo: hello from claude code` back. The gateway's log recorded
  `intercepted {"tool":"echo",...,"agent":"claude-code"}` then `decision allow risk=0 stub evaluator: allow everything`.
- Claude Code drops the gateway's stderr, so the gateway takes an optional `AGENTGATE_LOG_FILE` env var: when set, log lines
  are also appended to that file. Unset = no change.
- Claude Desktop: the `agentgate-demo` entry is in `claude_desktop_config.json`, but after a restart it produced no
  `mcp-server-agentgate-demo.log`, so it is unproven there (the Code tab may not read that file). Claude Code is the
  client we verified with.
- The CLI test needed a fresh `/login` (the OAuth session had expired); unrelated to the gateway.

### Hours 8-16: rule engine (`packages/gateway`)
- `src/rules.ts`: five rules, each returning `{ matched, riskScore, reason }`; the engine runs all of them and takes the
  highest score. Reasons name the field (e.g. `SSN in "body"`), never the value.
  1. **PII detector**: SSN (rejects impossible ones like 000/666/9xx), credit cards (15-16 digits + Luhn), emails, phone
     numbers, searched through nested args. SSN/card = 95 (block). Email/phone = 40 (escalate), but ignored in address-style
     fields (`to`, `cc`, `email`, `phone`, ...) since those are normal.
  2. **Destructive commands** (only on shell/SQL-looking tools): recursive `rm`, `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`,
     `DELETE FROM` (no WHERE = block, with WHERE = escalate), disk formatting (`format C:`, `mkfs`, `dd of=/dev/`).
     Plain "FORMAT" is not matched on its own, it is far too common a word.
  3. **Spending limit**: payment-looking tools with an `amount`/`total`/`price`/`cost` above $500 (parses `"$1,200.50"`) = block.
  4. **Rate limiter**: more than 20 calls per agent in 60s = block. Blocked attempts count too.
  5. **Blocked tools**: configurable names, `*` wildcards, case-insensitive.
- `src/evaluate.ts`: `createEvaluator(config, judge)`. Rules run first; a match returns immediately (score >= 70 block,
  30-70 escalate, else allow). Only calls no rule matched go to `judge`, currently a placeholder that allows. **Person 2's
  judge plugs in here.**
- Config via env: `AGENTGATE_BLOCKED_TOOLS` (comma-separated), `AGENTGATE_SPEND_LIMIT`, `AGENTGATE_RATE_LIMIT`,
  `AGENTGATE_RATE_WINDOW_MS`.
- Logging change: the gateway now logs argument **names** only, since values can hold PII. Set `AGENTGATE_LOG_ARGS=1` to
  log values while debugging.
- Tests: `npm test -w packages/gateway` (40 rule tests, incl. every example above and a <10ms check) and
  `npm run smoke -w packages/gateway` (adds an end-to-end SSN-blocked / safe-call-allowed check). All passing.

#### Known limits (fine for the hackathon, worth knowing)
- Rules only see plain arguments: no decoding of base64/URL-encoding, and no detection of obfuscated text.
- Tool kind (shell/SQL/payment) is guessed from the tool name, so a differently named tool is not covered. Patterns are in
  `DEFAULT_CONFIG`.
- The rate limiter keys on the MCP client name (e.g. `claude-code`), not a per-agent identity, and resets on restart.
- Amounts are assumed to be dollars.
- On Workers, `performance.now()` doesn't advance during pure computation, so `latencyMs` reads 0 there (the local Node
  server reports real numbers).
- On Workers the rate limiter's counts are per isolate and reset with it; a real deployment needs D1 or a Durable Object.
- Over HTTP the rate limiter trusts the caller's `agentId`, so a bot that rotates ids evades it. An API key per bot would fix
  that; not built.

### HTTP `/evaluate` endpoint (`packages/gateway`)
Person 3's bots are Python and can't speak MCP, so they call the gateway over HTTP instead. Same rules, same evaluator.
- `src/http.ts`: `POST /evaluate` and `GET /health`. The core (`handleRequest`) is a plain `Request -> Response` function so
  it can be reused on Cloudflare Workers later; `startHttpServer` is the thin Node wrapper. No new dependencies.
- `src/http-server.ts`: standalone mode, no MCP upstream needed: `npm run serve -w packages/gateway` (port 3000).
- `src/index.ts`: set `AGENTGATE_HTTP_PORT` and the MCP proxy also serves HTTP from the same process. Both front doors share
  one evaluator, so rate limits count MCP and HTTP calls together.
- `src/log.ts`: logging pulled out of `gateway.ts` so both front doors share it (no behavior change).
- Env: `AGENTGATE_HTTP_PORT`, `AGENTGATE_HTTP_HOST` (default `127.0.0.1`), `AGENTGATE_API_KEY` (optional).

**The contract (for Person 3):**
```bash
curl -X POST http://localhost:3000/evaluate -H 'content-type: application/json' \
  -d '{"toolName":"send_email","toolArgs":{"body":"SSN: 123-45-6789"},"agentId":"support-bot"}'
```
```json
{ "riskScore": 95, "decision": "block", "reasoning": "PII detected: SSN in \"body\"", "violatedPolicy": "pii_detector", "latencyMs": 0.28 }
```
```python
# Person 3's bots (httpx)
r = httpx.post("http://localhost:3000/evaluate", json={"toolName": "send_email", "toolArgs": {...}, "agentId": "support-bot"})
verdict = r.json()   # verdict["decision"] is "allow" | "block" | "escalate"
```
- Request: `toolName` (required), `toolArgs` (object, default `{}`), `agentId`, `sessionId`, `id` (all optional). `snake_case`
  names (`tool_name`, `tool_args`, `agent_id`) also work.
- **Send a stable `agentId` per bot.** The rate limiter counts per `agentId` (missing = `"unknown"`, shared by everyone).
- A `block` is a normal answer: **HTTP 200** with `"decision": "block"`. Errors: 400 bad request (with a message), 401 wrong or
  missing API key, 404/405 wrong path or method, 413 body over 1MB, 500 if the check itself crashed. The 500 body also says
  `"decision": "block"`, so a caller that only reads `decision` still fails closed.
- It only returns a decision; **the caller must honour it.** It does not run the tool.
- Tests: `src/http.test.ts` (15 tests, real server on a random port). All 55 unit tests + the smoke test pass. Round trip
  is about 0.2ms median locally. Verified by hand with `curl` against `npm run serve`.

### Hours 16-20: Worker + D1 (`packages/gateway`) — DEPLOYED and verified live on Cloudflare (rules only; judge + Sentry not connected)
- `src/worker.ts`: Cloudflare Worker entry (`POST /evaluate`, `GET /health`) reusing the same handler and rules. Logs every
  evaluated action to D1 (without delaying the reply, via `ctx.waitUntil`) and reads the `policies` table to switch rules on/off.
- `src/handler.ts`: the platform-neutral request handler, split out of `http.ts` so the Worker bundle doesn't pull in `node:http`.
  `http.ts` is now just the Node wrapper and re-exports it. `log.ts` no longer imports `node:fs` at load time (same reason).
- `src/policies.ts`: `createPolicyCache` (reads disabled policies, cached 15s, keeps the last state on error, all rules ON on a
  cold failure) and `insertActionLog`.
- `src/evaluate.ts`: `createEvaluator(config, judge, isEnabled)` gained the `isEnabled` hook; new `withAuditLog(evaluator, record)`
  records every decision without ever changing or delaying it (a failing write is logged and swallowed).
- `migrations/0001_init.sql`: tables `policies` (`id, name, description, type, pattern, enabled, updated_at`, seeded with the
  five built-in rules) and `action_logs` (`id, action_id, created_at, agent_id, session_id, tool_name, arg_keys, decision,
  risk_score, reasoning, violated_policy, latency_ms`, with indexes on time, agent and decision).
- `wrangler.jsonc`: Worker config with the `DB` binding (placeholder database id until `wrangler d1 create`).
- Scripts (`-w packages/gateway`): `dev:worker`, `db:local`, `deploy`. Wrangler is a dev dependency.
- **Tested for real, locally:** local D1 + `wrangler dev` on the actual Workers runtime (`workerd`). Safe/SSN/DROP TABLE calls gave
  the right decisions, three rows landed in `action_logs`, and no SSN value was stored anywhere. Flipping `enabled = 0` on
  `pii_detector` made the SSN call `allow` after the cache expired (<=15s); flipping it back restored `block`. `wrangler deploy
  --dry-run` bundles fine (36 KiB). 67 unit tests pass (12 new, using a fake D1).

**Done on Cloudflare (2026-09-19):** logged in with `wrangler login`; created D1 database `agentgate` (id `4d29b4a2-366f-48dc-ad16-b2b44d71e76a`, in
`wrangler.jsonc`; account id `3cc677046d8214ea8778cffc41dfb304`); applied `0001_init.sql` with `--remote` (tables + 5 seeded policies).
**Worker deployed 2026-09-19: https://agentgate-gateway.paivaaaryan.workers.dev** (account subdomain `paivaaaryan.workers.dev` already existed;
the first deploy attempt failed because wrangler couldn't auto-register one, a retry worked). Verified: `/health` = 200, `/evaluate` = 503 until
`AGENTGATE_API_KEY` is set (fails closed). **Gateway key set** (`wrangler secret put AGENTGATE_API_KEY`, generated with `openssl rand -hex 32`; the only copy is `~/aaryan/agentgate-api-key.txt`, mode 600,
outside the repo; give it to Person 3 privately). **Verified live:** an authenticated `POST /evaluate` with an SSN returned `block` /
`pii_detector` (HTTP 200), and the call appeared in the remote D1 `action_logs` table with argument names only (no SSN value stored).
`ENGINE_URL` and `SENTRY_DSN` are not set on the Worker yet, so it currently runs rules only. Steps 1-3 below are done.

**To deploy (needs your Cloudflare account; run these yourself in `packages/gateway`):**
1. `npx wrangler login` (opens a browser)
2. `npx wrangler d1 create agentgate`, then paste the printed `database_id` into `wrangler.jsonc`
3. `npx wrangler d1 migrations apply agentgate --remote`
4. `npx wrangler secret put AGENTGATE_API_KEY` (choose a long random key; give the same key to Person 3's bots)
5. `npx wrangler deploy`, then `curl https://<the-printed-url>/health`
The Worker refuses `/evaluate` (503) until `AGENTGATE_API_KEY` is set. For local dev the key lives in `.dev.vars` (git-ignored).

### Hours 16-20 Step 3: Person 2's AI judge (`packages/gateway`) — client matches their real engine; NOT connected in production
- `src/engine.ts`: `createEngineJudge({ url, timeoutMs, onError })` calls `POST {ENGINE_URL}/evaluate` for any call **no rule caught**;
  `judgeFromEnv()` builds it from env (no `ENGINE_URL` = no judge, unmatched calls are just allowed). Wired into `index.ts` (MCP proxy),
  `http-server.ts` (`npm run serve`) and the Worker.
- **Request format** (from `packages/engine/INTEGRATION.md` on Person 2's branch `person2/engine`, camelCase):
  `{ action: { id, agentId, toolName, toolArgs, sessionId, timestamp }, context: { sessionId, agentId } }`. (Our first version guessed a flat
  snake_case body; their server accepts that too, but this is the documented one.) **Reply**: `EvalResult` plus extras we ignore
  (`category`, `retrievedPolicies`, `patternNotes`, `guardrails`); snake_case names also accepted. If `degraded: true` (a node fell back
  instead of using its model) the reasoning gets a `[degraded]` prefix. Missing `decision` is derived from the score (30/70 bands).
- **Timeout 30s** (was 8s): their judge has a 25s internal timeout and their guide says a shorter client timeout turns good decisions into
  needless escalations. Measured latency on their side is about 1.8s mean, 2.7s p95.
- **Fails safe**: timeout, unreachable, HTTP error or a nonsense reply gives `escalate` (which blocks for now), risk 50,
  `violatedPolicy: "judge_unavailable"`. `AGENTGATE_JUDGE_ON_ERROR=allow|block` and `AGENTGATE_JUDGE_TIMEOUT_MS` change that.
- **Sessions**: their pattern detector (cumulative spend, repeats) keys off `sessionId`. MCP proxy: one per process. HTTP: the caller's
  `sessionId`, or if omitted `agent:<agentId>` (was one shared `http` bucket, which would have mixed every bot together).
  Person 3's bots should send a stable `sessionId` per conversation.
- **Privacy**: rules run first, so a call the rules block (SSN, card, ...) never reaches the engine (tested, and confirmed against the real
  engine: its counter did not move). Calls no rule catches go to the engine with full arguments, and from there to OpenAI.
- `src/fake-engine.ts` (`npm run fake-engine -w packages/gateway`): stand-in engine on :8000 that speaks the real format.
- **Verified against Person 2's REAL engine** (extracted from `origin/person2/engine` into a scratch folder, Python 3.12 venv, their 35
  offline tests pass, run with NO OpenAI key and no Cloudflare credentials; nothing in the repo or on their branch was touched):
  requests accepted, replies parsed, `degraded` surfaced, rule-blocked calls never reached it, and one session across 14 x $400
  payments raised its risk score to 60 with policy "Action Rate Limits".
- **NOT verified**: the real GPT judge (needs Person 2's OpenAI key, so its verdict quality is unseen) and the live path.
- **To connect for real**: the engine is Python and cannot run on Workers, and a deployed Worker cannot reach `localhost`. Person 2 must host it
  (Render/Railway/Fly/Cloud Run, see their `DEPLOYMENT.md`) or tunnel it, ideally with a shared key because it has no auth of its own
  (anyone with the URL could spend their OpenAI credits). Then `ENGINE_URL` goes on the Worker. For a one-laptop demo: their engine on
  `localhost:8000` plus the local gateway (`ENGINE_URL=http://localhost:8000 npm run serve -w packages/gateway`).
- **Merge notes** (Person 2's branch changes non-engine files too): `.env.example`, `.gitignore`, `README.md`, root `package.json`
  (their workspaces list is `packages/gateway, packages/shared, apps/dashboard`), `package-lock.json`, `packages/shared/*`
  (adds `types.py`, `pyproject.toml`, `SessionContext`/`Decision`/`ActionCategory` in `types.ts`, `type: module` + `exports` in its
  `package.json`). Expect conflicts there; `package-lock.json` should be regenerated. The engine shares our D1 database safely: it only
  creates `agentgate_sessions` (plus a Vectorize index), no name clash with `policies` / `action_logs`.
- Tests: `src/engine.test.ts` (18 tests). Whole suite: 96 passing.

### Step 3 update: wired to Person 2's LIVE engine (2026-09-19) — DONE and verified live
Person 2's agent sent a spec for the live engine (a Cloudflare quick-tunnel to their laptop; the user confirmed the message was accurate and authorised the wiring).
- **Client changes** (`src/engine.ts`): flat camelCase request `{ agentId, toolName, toolArgs, sessionId }` (was nested `{action, context}`), `Authorization: Bearer <key>`,
  the URL may be the full `.../evaluate`. Config is now `AGENTGATE_ENGINE_URL` + `AGENTGATE_ENGINE_KEY` (`ENGINE_URL` still accepted). Keys never appear in code, logs,
  verdicts or Sentry. Rules-first, fail-closed (`escalate`) and the 30s timeout were already in place; a 401 also fails closed.
- **Extras kept**: `category`, `retrievedPolicies`, `patternNotes`, `guardrails`, `degraded` (a `Verdict` = `EvalResult` + extras + `decidedBy`). `decidedBy` is `rules`, `judge`, or
  `fallback` (no judge configured, or judge unreachable/rejected). These also come back in our `/evaluate` reply.
- **D1** (`migrations/0002_judge_details.sql`, applied to the live database): `action_logs` gains `tool_args`, `category`, `degraded`, `decided_by`, `retrieved_policies`,
  `pattern_notes`, `guardrails`. Uses the existing database `4d29b4a2…`; the engine's `agentgate_sessions` table (25 rows) was not touched, and Vectorize was not touched.
- **Deviation from their spec: `toolArgs` are stored REDACTED** (`src/redact.ts`): SSNs/cards/phones masked, emails keep only their domain, keys like password/token/secret/
  api_key/authorization blanked, long values cut, 4000-char cap. Their spec asked for raw `toolArgs`; storing raw would put SSNs and card numbers in a table. Flip this only on purpose.
- **Deployed** Worker `38f0e9bc`. Secrets on the Worker: `AGENTGATE_API_KEY`, `SENTRY_DSN`, `AGENTGATE_ENGINE_URL` (set by Claude, not a credential) and `AGENTGATE_ENGINE_KEY`
  (pasted by the user; Claude does not enter keys). Before the key was set, the engine answered 401 and unmatched calls failed closed to `escalate`.
- **VERIFIED LIVE through the deployed gateway** (real GPT judge, engine reachable, `retrieval: hybrid`):
  1. `upload_file` of `/db/customers.sql` to `https://dropbox.com/u/xyz` -> `block`, risk 100, policy "Agent-Controlled Destinations", `decidedBy: judge`, category
     `system_modification`, real reasoning, 3198ms. (Before: `allow` / "AI judge not connected yet".)
  2. `send_email` with an SSN -> `block`, risk 95, `pii_detector`, `decidedBy: rules`, 0ms, engine not called. Fast path intact.
  3. Both rows are in the live D1 `action_logs` with the new columns; `tool_args` are masked (`{"to":"***@gmail.com","body":"SSN [SSN]"}`), 0 raw SSNs/emails in the table.
- Tests: 108 passing (new: auth header, flat payload, extras, `decidedBy`, 401 fail-closed, redaction, D1 columns). Also checked end to end locally with a key-protected stand-in engine.
- Caveats: the tunnel dies when Person 2's laptop sleeps (then unmatched calls escalate); the engine has its own OpenAI cost per call; both the engine key and our gateway key were
  pasted into chats, so rotate them after the demo.

### Hours 16-20 Step 4: Sentry (`packages/gateway`) — DONE: DSN set on the Worker and in .env; test event sent
- `src/monitoring.ts`: tiny hook layer (`reportError`, `decisionBreadcrumb`, `scrubEvent`, `setMonitor`) with no Sentry import, so
  the same calls work in Node and on Workers. `sentry-node.ts` plugs `@sentry/node` in behind it for the MCP proxy and the local
  HTTP server (loaded only if `SENTRY_DSN` is set); `worker-entry.ts` wraps the Worker with `@sentry/cloudflare`'s `withSentry`
  (wrangler's `main` now points at it; `worker.ts` is the plain logic, so tests don't load the Cloudflare SDK).
- **What gets reported** (tagged `where`): the evaluator crashing (MCP and HTTP, both fail closed), a failed audit-log write,
  the AI judge being unreachable, a failed policy read, plus uncaught errors on the Worker. Every decision leaves a breadcrumb
  (tool, agent, session, risk, policy: no arguments), so a report shows what led up to it.
- **Privacy** (tested with the real SDK against a fake transport, 94 tests total): request body, headers (incl. the gateway key),
  cookies, URL and user IP are stripped (`beforeSend`); local-variable capture is off (tool arguments sit in local variables);
  console breadcrumbs are dropped (our log lines would carry argument values under `AGENTGATE_LOG_ARGS=1`); machine hostname is
  replaced with `agentgate`. Sentry does still attach a few lines of our own source code around a stack frame, and system info.
- Config: `SENTRY_DSN` (turns it on), `SENTRY_ENVIRONMENT` (optional label). Same DSN works for the Worker and local processes.
- Redeployed the Worker with this code (`d4f842b7`); verified `/health` = 200, bad/missing key = 401. It sends nothing until the DSN is set.
- **Sentry is on.** `SENTRY_DSN` was set on the Worker (`wrangler secret put`) and in the git-ignored `.env`; `npm run sentry:check` printed "Sent" (the SDK
  confirmed delivery). Seeing the test error appear in the Sentry project is the last confirmation (done by the user in the Sentry UI). Harmless
  Node deprecation warning (`module.register()`) comes from Sentry's loader on Node 26. Original setup steps, kept for reference: create a Sentry project, then
  `npx wrangler secret put SENTRY_DSN` (Worker) and put `SENTRY_DSN=...` in the git-ignored `.env`; verify with
  `npm run sentry:check -w packages/gateway`, which sends one test error.
- Note: after changing `database_id` in `wrangler.jsonc`, local dev uses a fresh empty local D1; run `npm run db:local -w packages/gateway` once.

### Deviations from the starter guide
Where what we built differs from `docs/STARTER_GUIDE.md`, and why. Newest last.

**Repo setup (Phase 0)**
- Skipped Step 5 (API key signups) and Step 6 (Cloudflare hello-world). Not needed for Person 1 until hours 16-20.
- Added a `.gitignore` (not in the guide) so `.env`, `node_modules`, `venv` etc. never get committed.
- `.env.example` contents were chosen by us; the guide doesn't say what goes in it.
- Renamed the `shared` workspace package to `@agentgate/shared` (with `main`/`types` pointing at `types.ts`) so the gateway can
  import the types by name. `types.ts` itself is exactly the guide's version. **Teammates' `packages/shared/package.json`
  will differ from ours; reconcile when merging.**
- Saved the guide as `docs/STARTER_GUIDE.md` with a simpler filename.

**Hours 1-8: MCP proxy**
- The guide puts everything in `src/index.ts`. We split it: `gateway.ts` (proxy logic), `evaluate.ts` (evaluator), `index.ts`
  (the command that starts it).
- Wrote `tsconfig.json` by hand instead of `npx tsc --init`; also installed `zod` and `@types/node`. TypeScript resolved to 7.x.
- **Fails closed**: if `evaluate()` throws, the call is blocked. Not in the guide.
- **Step 3 (test with Claude Desktop) was not done in Claude Desktop.** We verified with the `claude` CLI (Claude Code) and an
  SDK stdio client instead. The `agentgate-demo` entry is in `claude_desktop_config.json` but never showed up in Claude
  Desktop's logs, so it is unproven there.
- The guide expects the intercepted call to print to your terminal. Under an MCP client it goes to stderr (stdout is the
  protocol channel), which Claude Code drops, so we added an optional `AGENTGATE_LOG_FILE`.
- Tested against our own `mock-upstream.ts` (tools `echo`, `lookup_order`) instead of a real tool server.
- Extras not in the guide: `smoke-test.ts`, `mock-upstream.ts`.

**Hours 8-16: rule engine**
- Runs **all** rules and returns the highest-scoring result, instead of stopping at the first match, so the rate limiter
  always sees every call. Same outcome as the guide's "if any rule matches, return the decision".
- "Throttle" (rate limiter) is implemented as a block, same as the other rules.
- **`FORMAT`**: only disk-wiping forms are matched (`format C:`, `mkfs`, `diskutil erase`, `dd of=/dev/`); the bare word is
  too common in normal SQL/text.
- **`DELETE FROM`**: no WHERE = block; with WHERE = escalate (targeted delete). The guide treats every `DELETE FROM` the same.
- **PII**: emails/phones are ignored in address-style fields (`to`, `cc`, `email`, `phone`, ...) or `send_email` would trip
  on every call. Cards are 15-16 digits (Amex included), Luhn-checked, first digit 2-6. SSNs reject impossible ranges
  (000, 666, 9xx, group 00, serial 0000). Phone numbers need separators/parentheses so plain 10-digit ids don't match.
- Block reasons name the field, never the sensitive value.
- **Logging now records argument names only** (values only with `AGENTGATE_LOG_ARGS=1`), because logging raw args would put
  SSNs into our own logs. Earlier entries in this file that mention logging args describe the old behavior.
- Extras not in the guide: env-var config, 40 unit tests (`src/rules.test.ts`), an end-to-end rule check in the smoke test.
- Escalate still blocks (no reviewer yet), so an email inside a message body is blocked, not just flagged.

**HTTP endpoint**
- The guide says the bots POST to the gateway's `/evaluate` but never says how; this is our answer, it is not in the guide.
- The endpoint returns the decision only; it does not forward or run the tool. (The guide says the tool servers run "on
  Person 1's side"; if the demo needs the gateway to actually execute the bots' tools, that is a separate, bigger piece.)
- The server ignores any client-supplied timestamp and uses its own clock, otherwise a bot could send old timestamps to slip
  past the rate limiter.
- Binds to `127.0.0.1` by default, with an optional `AGENTGATE_API_KEY`. Set the key before exposing it anywhere public
  (needed for the Cloudflare deploy).
- Field names accept both `camelCase` (the guide's test dataset) and `snake_case` (the guide's Python example).

**Worker + D1**
- Only the HTTP side goes on Cloudflare. The MCP stdio proxy spawns local processes, which Workers can't do, so it stays local.
  Calls through the MCP proxy are therefore **not** in D1's `action_logs`; only `POST /evaluate` calls are.
- `action_logs` stores argument **names** only, never values (they can hold PII). The row id is server-generated, so a caller-
  supplied `id` can't overwrite or suppress log rows (the caller's id is kept in `action_id`, not unique).
- The `policies` table really switches rules: a row with `enabled = 0` turns the rule with that `id` off. (The guide only asks
  for the tables; an inert table would have made the dashboard's toggle a lie.)
- The Worker requires `AGENTGATE_API_KEY` and answers 503 without it, unless `AGENTGATE_ALLOW_ANONYMOUS=1`. Not in the guide;
  a public endpoint with no key lets anyone fill the log and probe the rules.
- Only wired for D1 in the Worker; the local Node server (`npm run serve`) logs to stderr/file, not D1.
- Step 3 and Step 4 are documented separately (above).

**Changes outside the repo** (not committed, nothing to merge)
- `~/Library/Application Support/Claude/claude_desktop_config.json`: added the `agentgate-demo` server (backup next to it as
  `claude_desktop_config.json.bak-before-agentgate`). Remove the entry if unwanted.
- Scratch files in `~/aaryan/`: `agentgate-mcp.json`, `agentgate.log`, `cc-debug.log`, `cc-debug2.log`.

### Next
- Set `AGENTGATE_ENGINE_KEY` on the Worker, then run the two verification calls (Dropbox upload must `block`; SSN email must still block with no engine call).
- Merge `person2/engine` with `aaryan` (see merge notes in Step 3).
- Deploy the Worker: set the secret yourself (`npx wrangler secret put AGENTGATE_API_KEY`), then `npx wrangler deploy`. D1 is already live.
- Step 4: give the Worker and `.env` the Sentry DSN, then run `npm run sentry:check -w packages/gateway`.
- Tell Person 3 the `/evaluate` contract (needs `Authorization: Bearer <key>` on the deployed Worker) and agree `agentId`s.
