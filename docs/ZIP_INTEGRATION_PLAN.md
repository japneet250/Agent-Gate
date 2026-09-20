# Zip integration — plan

Goal: make Zip a first-class, demo-ready part of AgentGate, using the HTN
staging environment from Zip's setup doc.

**Read this first: Zip is already partly integrated.** `main` has both halves
(see `packages/engine/ZIP.md`). This plan is about closing what is left and
making it demoable, not starting over.

## What already exists

| Piece | Where | State |
| --- | --- | --- |
| Gateway in front of Zip's MCP server (`ziphq-mcp`, 131 tools, 66 write/destroy) | `packages/gateway/src/mcp.ts` (`zip` server), `upstream.ts` | Built. Verified refusing `zip_delete_vendor`, `zip_delete_user`, `zip_upsert_budgets` |
| Judge grounded in Zip's REST state (vendors, approvals) | `packages/engine/src/agentgate_engine/zip_client.py`, `engine.py`, `nodes/judge.py` | Built. Header is `Zip-Api-Key`, base is `staging-api.zip.com` |
| Procurement policies | `policies/approval-chain.md`, `budget-exhaustion.md`, `spending-limit-cumulative.md` | Built |
| Cumulative "approval splitting" detector | `nodes/pattern_detector.py`, `limits.py` | Built; fires at transaction #13 |
| Tests against a mock Zip | `packages/engine/tests/test_zip.py` | 9 tests |

## What is missing (the work)

1. **Budget grounding.** `GET /budgets` is 405 over REST. Budget state is only
   readable through Zip's MCP tool `zip_search_budgets`. Today the engine
   silently skips budgets, which is the strongest half of the Zip story.
2. **Two names for one key.** Zip's doc and `ziphq-mcp` use `ZIP_API_KEY` /
   `ZIP_API_URL`. The engine's REST client uses `ZIP_API_TOKEN` /
   `ZIP_API_BASE`. Neither set is in `.env.example`. Set only one and half the
   integration is quietly off.
3. **`zipFacts` never reaches the user.** The engine returns `zipFacts`, but
   the gateway's `Verdict` type drops it, D1 does not store it, and the
   dashboard trace drawer cannot show it. The "why" (real budget, real vendor,
   real approvers) is the demo's best evidence and it is invisible.
4. **Hardcoded MCP path.** `mcp.ts` runs `~/.local/bin/ziphq-mcp`. Zip's doc
   uses `uv run --with ziphq-mcp ziphq-mcp`. On this machine neither `uv` nor
   `ziphq-mcp` is installed.
5. **Cumulative accumulator only sums top-level fields.** `limits.py` accepts
   `sum(toolArgs.<field>)` with a plain identifier. Zip's purchase requests
   very likely carry amounts inside nested line items, so the "$400 x 13" story
   may not fire on real Zip calls. Unverified until we see real arguments.
6. **No scripted Zip scenario.** Zip's doc gives a concrete workflow (request,
   PO, invoice, bill, approve, pay). Nothing replays it through the gateway.
7. **Docs are stale.** `ZIP.md` still has a "the token is being rejected"
   section that later commits fixed. `CONTEXT.md` and `README.md` disagree on
   what is built.

## Plan

### Phase 0 — Access and setup (you, about 15 min)

Only you can do these. I will not handle the key.

- [ ] Ping `#spons-zip-2026` for access; set your password from the email.
- [ ] Create a key at `{your-domain}/manage/api-key` (standard key is fine).
- [ ] Put it in the git-ignored `.env`, **under both names**:
  ```
  ZIP_API_URL=https://staging-api.zip.com
  ZIP_API_KEY=<key>
  ZIP_MCP_MODE=readwrite
  ZIP_API_BASE=https://staging-api.zip.com
  ZIP_API_TOKEN=<same key>
  ```
- [ ] Install the tooling: `brew install uv`, then `uv tool install ziphq-mcp`.
- [ ] Confirm `git check-ignore -v .env` shows it is ignored before anything runs.
- [ ] Ask the sponsor channel whether your instance is shared. The doc warns it
  may be, so keep writes small (see Phase 5).

**Done when:** `uv run --with ziphq-mcp ziphq-mcp` starts, and
`curl -H "Zip-Api-Key: $ZIP_API_KEY" https://staging-api.zip.com/vendors`
returns a `{"list": ...}` body (not a 401).

### Phase 1 — Config hygiene (small, low risk)

- [ ] Add the Zip block above to `.env.example` (placeholders only).
- [ ] In `config.py`, let `zip_api_token` fall back to `ZIP_API_KEY` and
  `zip_api_base` fall back to `ZIP_API_URL`, so one set of variables works for
  both halves (same trick already used for the three LangFuse spellings).
- [ ] In `mcp.ts`, replace the hardcoded `~/.local/bin/ziphq-mcp` with
  `uv run --with ziphq-mcp ziphq-mcp` (fall back to the binary if `uv` is
  missing), and allow an override via `ZIP_MCP_COMMAND`.
- [ ] Extend the existing `test_zip.py` / gateway tests for the fallback names.

**Done when:** setting only `ZIP_API_KEY` and `ZIP_API_URL` turns on both the
MCP proxy and the REST grounding.

### Phase 2 — Learn the real tool surface (about 30 min, read-only)

Everything after this depends on real Zip argument shapes, which we have not
seen.

- [ ] Run the gateway against Zip and dump the 131 tool names and their input
  schemas to a file (`docs/zip-tools.json`). Mark each read / write / destroy.
- [ ] Do the doc's demo flow once **directly** in Zip's UI, then read the
  resulting request, PO, bill and vendor via read-only tools, to capture real
  argument and response shapes.
- [ ] Record: which tool names the gateway's `paymentToolPattern`
  (`pay|refund|purchase|charge|transfer|checkout|invoice|billing`) already
  catches, which it misses, and where the amount lives in each.

**Done when:** we can say for each money-moving Zip tool where the amount,
vendor and budget appear in its arguments.

### Phase 3 — Budget grounding through MCP (the main build)

Design: the **gateway** already holds the only Zip MCP connection, so it does
the budget lookup and hands the result to the engine. That keeps the property
"the agent never holds a Zip credential" and avoids a second Zip client.

- [ ] Gateway: before calling the engine on a financial action (Zip tool names,
  from Phase 2), call `zip_search_budgets` on its upstream client, pick the
  matching budget, reduce it to the same plain-sentence facts `ZipContext`
  already produces.
- [ ] Contract: add one optional field to the engine request, for example
  `context.groundingFacts: string[]`. Additive, so older callers keep working.
  Tell whoever owns `INTEGRATION.md`.
- [ ] Engine: merge `groundingFacts` into `zip_facts` in `engine.py` next to the
  REST-derived vendor and approval facts.
- [ ] Fail soft, as the rest of the engine does: if the MCP lookup fails or
  times out, say so in the prompt and judge on policy alone. Keep the added
  latency small; the judge is already about 2s.
- [ ] Tests: a mock upstream that returns a budget, asserting the facts reach
  the judge prompt; one asserting a failed lookup degrades instead of blocking
  the call.

**Limit to be honest about:** this works for the MCP path only. The Cloudflare
Worker's `/evaluate` path has no MCP upstream, so it stays REST-only.

**Done when:** the same $4,000 purchase order is judged differently with and
without Zip, and the difference cites a real budget by name.

### Phase 4 — Make it visible

- [ ] Add `zipFacts` to the gateway `Verdict` (`evaluate.ts`) and pass it
  through `engine.ts`.
- [ ] New D1 migration `0003_zip_facts.sql` adding a `zip_facts` column;
  redact before storing, same as `tool_args`.
- [ ] Dashboard: show the facts in the trace drawer as a "What Zip knew"
  section (`apps/dashboard/components/feed/trace-drawer.tsx`, provider types in
  `lib/data/types.ts`, `live-provider.ts`).

**Done when:** clicking a blocked Zip action in the dashboard shows the real
budget, vendor and approver lines that drove the decision.

### Phase 5 — The Zip scenes (demo and tests)

Use Zip's own workflow so it looks like the sponsor's product, not ours. Vendor
`Lemongrass Lemon Co`, subsidiary `Zip - Modern Spend Approvals`.

**Safe run** (should all be **allowed**): create a request, finalize it, check
the PO, create a bill from the sample invoice, approve, mark paid.

**Attack run** (should be **refused or escalated**, and never touch the shared
instance):

| Attack | Expected | Why it is safe to demo |
| --- | --- | --- |
| Delete a vendor / user | block (destructive) | Refused before Zip sees it |
| Set a budget to a huge number | block (spending limit) | Refused before Zip sees it |
| PO to a vendor not on the approved list | block or escalate, cites Zip | Read-only lookup only |
| Agent approves its own bill | block (`approval-chain`) | Refused before Zip sees it |
| Many small requests that add up | escalate at the limit | Only needs the first few to reach Zip |

Because refused calls never reach Zip, the attack run barely changes a shared
staging company. Keep the allowed writes to one request or PO per take.

- [ ] Add `packages/demo-agents` persona `zip` with `safe` and `dangerous`
  scripts, routed through the gateway (the demo agents already go through it on
  `main`).
- [ ] Add 8 to 10 Zip scenarios to `packages/evals/scenarios.json` with
  labels agreed first (see the open threshold disagreement in `CONTEXT.md`).
- [ ] Add a "Zip" scene to the demo script: same agent, same task, gateway off
  versus on.

### Phase 6 — Docs and cleanup

- [ ] Rewrite the status sections of `ZIP.md` to match reality; delete the
  resolved "token is being rejected" section.
- [ ] Align the README and `CONTEXT.md` on what is built.
- [ ] Write the Zip sponsor paragraph for the Devpost: "governs Zip's real
  131-tool MCP server and grounds every purchase decision in Zip's live budget,
  vendor and approval state."

## Stretch (only if everything above is done)

**Close the escalation dead end using Zip.** Today an escalated call is just
blocked and `/review` writes nothing back. Zip has a real approval system.
An escalated purchase could create a Zip approval request instead. This is the
most compelling Zip story, but it is a write into a possibly shared instance
and needs the Phase 2 tool list to know it is possible. Do not start it before
Phase 5.

## Risks

- **Shared staging instance.** Another team may be using the same company. Keep
  writes minimal and never run destructive tools "to test" against it.
- **API key handling.** The key stays in `.env`, never in chat, logs, D1 or
  Sentry. Rotate it after the demo.
- **Unverified shapes.** Phases 3 to 5 assume things about Zip's argument and
  response shapes that Phase 2 exists to check.
- **Latency.** Extra Zip lookups add to a judge that already takes about 2s.
  Measure before the demo.
- **Node and Python versions.** The repo pins Node 18 but the current machine
  runs Node 26, and the engine needs Python 3.10+ (system Python is 3.9).

## Suggested order and time

| Phase | Effort | Blocks on |
| --- | --- | --- |
| 0 Access and setup | 15 min | you |
| 1 Config hygiene | 30 min | none |
| 2 Learn the tool surface | 30 min | Phase 0 |
| 3 Budget grounding via MCP | 2 to 3 h | Phase 2 |
| 4 Make it visible | 1 to 2 h | Phase 3 |
| 5 Zip scenes | 1 to 2 h | Phases 1 and 2 |
| 6 Docs | 30 min | all |

If time is short: Phases 0, 1, 2 and 5 already give a live, honest Zip demo.
Phase 3 is what makes the Zip prize story strong.
