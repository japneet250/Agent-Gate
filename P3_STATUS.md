# Person 3 — status and handoff

Last updated: 2026-09-19. Branch `person3`. Nothing is pushed (no remote).

Start with `CLAUDE.md` for orientation and scope boundaries. The team-facing doc
is `SHARED_CONTEXT.md` on `main` (`git show main:SHARED_CONTEXT.md`).

---

## TL;DR — where things stand

Deliverables 1–5 plus the follow-up hardening are **done, committed, and
verified against local backends**. Two things are blocked and neither is on me:

| # | item | state |
| --- | --- | --- |
| 1 | Mock MCP tool servers + demo agents | done |
| 2 | Eval harness, 100 labelled scenarios | done |
| 3 | Sentry — errors + **tracing** + **logs** | done, transport-verified |
| 4 | LangFuse — tracing + per-scenario scores | done, transport-verified |
| 5 | Dual-model evals (OpenAI + Gemini) + hardening | done, mock-verified |
| 6 | Regression gate | done, verified by deliberate breakage |
| 7 | MongoDB eval-run history | done, verified against real mongod |
| 8 | Version pins + `npm run doctor` | done |
| 9 | Product-number guard (`isProductNumber`) | done |
| — | **Live backend verification** | **BLOCKED — no `.env`** |
| — | **Re-baseline on P2's engine** | **BLOCKED — no `packages/engine`** |

Not started (stretch, needs the user's go-ahead): CSE Log & Order, GPTZero,
DeepEval, RAGAS, OpenTelemetry.

---

## BLOCKER 1 — no `.env`, so nothing is live-verified

The user said real keys were added for Sentry, Gemini and LangFuse. **They are
not present.** `find . -name ".env*"` returns only `.env.example`, and
`SENTRY_DSN` / `GEMINI_API_KEY` / `LANGFUSE_*` are unset in the environment.

Everything is therefore verified against **local collectors and mock provider
endpoints only**. That was reported to the user plainly; do not restate it as
live verification.

**When the user provides `/home/megh/HTN2026/.env`:**

1. Confirm it is gitignored and untracked before any run:
   `git check-ignore -v .env && git status --porcelain .env`
   (root `.gitignore` line 4 already covers `.env`.)
2. Never print or commit key values.
3. Run the two live runs:
   ```bash
   npm run agent -w @agentgate/demo-agents -- --agent=coding --mode=dangerous
   npm run eval  -w @agentgate/evals
   ```
4. Confirm acceptance **at the transport level** — 2xx / envelope accepted, not
   merely "no error thrown" — and report counts for transactions, logs and
   LangFuse scores.
5. Then print a **VERIFY IN UI** block for the user containing: exact
   transaction/span names, exact log messages, the score name
   (`decision_correctness`), and the run timestamp + trace ids.
   **State plainly that dashboard confirmation is the user's to do, not ours** —
   we cannot see Sentry.io or the LangFuse UI.

Expected counts, from the local-collector run (useful as a sanity check):
demo-agents = 1 transaction / 4 evaluate spans / 3 logs; evals (dangerous only)
= 30 evaluate spans / 28 logs / 30 scores.

**Before spending Gemini quota on a full 100-scenario run**, note the free-tier
RPM cap. `--category=dangerous` (30 scenarios) is the cheaper first contact.

---

## BLOCKER 2 — the engine re-baseline (P2)

`packages/engine` does not exist. There are no `person1`/`person2` branches.

Every baseline in `report.json` so far is the **stub**; every model number is the
**P3 judge wrapper**. Both are superseded the moment P2 lands.

The moment `@agentgate/engine` exports `evaluate`, run exactly:

```bash
npm run eval -w @agentgate/evals -- --model=engine --update-baseline
```

That is **the only run whose number may be quoted as AgentGate's score.** Then
append a Decisions Log line saying prior baselines are superseded.

`--model=engine` currently refuses to run rather than silently scoring the stub
under the engine's name — verified. Keep that behaviour.

---

## What exists, and how to run it

### `packages/demo-agents`

Three stdio MCP mock servers — they log to **stderr** (so stdout stays clean for
JSON-RPC) and return canned success. No real side effects anywhere.

| server | tools |
| --- | --- |
| `customer-support` | `send_email`, `lookup_customer`, `issue_refund` |
| `procurement` | `create_purchase_order`, `approve_payment`, `check_budget` |
| `coding` | `run_command`, `write_file`, `query_database` |

Tool names, zod arg schemas and canned responses are defined once in
`src/tools/catalog.ts`. P1 spawns a server via `mockServerCommand(name)` from
`src/servers/launch.ts` — never a hardcoded path.

Three agent personas (`support`, `procurement`, `coding`), each with a `safe` and
a `dangerous` run. Runs are **deterministic scripts by default**, so the demo
works with no API key; `--llm` drives a real OpenAI tool-calling loop.
`--gate=off` shows the "before AgentGate" behaviour where everything sails through.

### `packages/evals`

`scenarios.json` — 100 labelled scenarios: 40 safe→allow, 30 dangerous→block,
20 ambiguous→escalate, 10 cumulative (only decidable from `priorActions`).

**Stub baseline: accuracy 91%, macro-F1 0.895.** Known stub gaps, left in
deliberately as headroom for P2: misses `rm -rf ~/` and fork bombs, treats
`GRANT ALL` as a mere schema change, cannot separate a $10k payment that should
escalate from one that should block.

Key modules:
- `src/engine/stub.ts` — ~12-rule stub. **Temporary; delete when P2 lands.**
- `src/engine/index.ts` — `resolveEvaluate()`, swaps on `AGENTGATE_ENGINE`.
  Holds the `EvaluateOptions` TODO for P2.
- `src/score.ts` — runs a suite; owns the `scored / invalid / skipped / errored`
  buckets. **Only `scored` rows reach the metrics.**
- `src/models/` — the P3 judge wrapper: one provider-agnostic prompt
  (`prompt.ts`) sent byte-for-byte through both providers, `judge.ts`,
  `errors.ts` (retry + failure buckets), `registry.ts` (model ids, tiers).
- `src/regression.ts` — the regression gate.
- `src/compare.ts` — disagreement-first comparison output.
- `src/history.ts` — MongoDB eval-run history.

### `packages/observability`

Sentry (errors + tracing + logs) and LangFuse (tracing + scores). Both no-op
without keys. **LangFuse span tree — P1/P2 must use these exact names:**

```
agentgate.agent.run          (P3) one demo-agent run / one eval suite
  agentgate.tool_call        (P3) one attempted tool call
    agentgate.evaluate       (P2) evaluate() — P2 nests judge/RAG/pattern spans UNDER this
    agentgate.tool_exec      (P3) forwarded call to the real tool; absent unless allowed
```

Import the `SPAN` constants rather than retyping the strings.

---

## Design decisions worth not re-litigating

- **Cumulative spend books on `approve_payment` only, and only when allowed.**
  Otherwise a PO and its matching payment double-count. P2 should match this.
- **Metrics over `scored` rows only.** A schema failure (`invalid`) or a rate
  limit (`skipped`) is a plumbing problem, not a wrong decision — counting them
  as wrong would libel a provider.
- **Macro-F1 is skipped for single-label slices** (e.g. `--category=dangerous`),
  because averaging in classes that cannot score fails every run for a reason
  that says nothing about quality. Per-class recall still applies.
- **A failing regression run never overwrites the baseline** — it parks in
  `report.failed.json`. Otherwise one bad commit silently resets the bar.
  `--update-baseline` accepts it deliberately.
- **A scenario-set hash guards the diff**, so a report scored on different
  scenarios is reported as not comparable rather than silently compared.
- **Comparison labels are built from exact model ids**, so a
  `gpt-4o-mini` vs `gemini-2.5-flash` run cannot be written up as
  "GPT-4o vs Gemini". Cross-tier pairs print a TIER MISMATCH warning.
- **Disagreements are the headline; aggregate percentages are secondary.** The
  horserace invites a fairness argument we cannot fully win.

---

## Open questions for the team

1. **P2 — confirm `SessionContext`.** P3 exported a provisional shape to
   `shared-types` so everyone shares one definition. It is P2's to own.
2. **P2 — accept or reject `evaluate(action, context, opts?: { model?: string })`?**
   Until confirmed, the model comparison bypasses P2's pipeline entirely via the
   P3 judge wrapper. See `EvaluateOptions` in `packages/evals/src/engine/index.ts`.
3. **Team — move to Node 20?** `@google/genai` v2 declares `node >= 20` and
   `mongodb` v7 requires `>= 20.19`. We run 18.20.5. Only `@google/genai@1.0.x`
   supports 18 and it is too old to want. Flagged, not decided.
4. **User — confirm the judge model ids** before the demo. Defaults are
   `gpt-4o-mini` / `gemini-2.5-flash`, overridable via `OPENAI_JUDGE_MODEL` /
   `GEMINI_JUDGE_MODEL`.

---

## Verification commands — all currently passing

```bash
npm run doctor                                # no drift
npm run smoke        -w @agentgate/demo-agents
npm run verify       -w @agentgate/observability   # Sentry+LangFuse, local collector
npm run verify:judge -w @agentgate/evals          # 20 checks, mock providers, no API spend
npm run eval         -w @agentgate/evals
for p in shared-types observability evals demo-agents; do npx tsc -p packages/$p/tsconfig.json --noEmit; done
```

`report.json`, `report.failed.json` and `report.by-model.json` are gitignored —
regenerate with a run rather than expecting them in a fresh clone.
