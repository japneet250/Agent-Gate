# AgentGate — Dashboard

The control plane. A dark, layered interface that dramatises what the gateway and
engine do to every tool call an agent attempts.

It runs **standalone on mock data** and swaps to the live backend with one env
var. The mock data is not invented — it is a deterministic replay of the real
eval suite.

```bash
npm install          # from the repo root (npm workspaces)
npm run dev -w @agentgate/dashboard      # http://localhost:3100
```

`dev` and `build` regenerate fixtures first, so the dashboard always reflects the
current `report.json`.

---

## Data modes

`NEXT_PUBLIC_DATA_MODE` in `.env.local` (copy `.env.example`):

| mode | behaviour |
| --- | --- |
| `mock` (default) | deterministic replay of 106 real evaluated actions. No backend, no keys, no network. |
| `live` | polls the gateway, reads policies from the engine. |

**The mode badge is always visible in the nav and never abbreviates.** In mock
mode it says "Mock data" and its tooltip names the exact files the replay came
from. A dashboard that looks live while replaying fixtures is the one failure
mode worth engineering against, so live mode never silently falls back to mock —
it renders an explicit empty state instead.

## Where the mock data comes from

`scripts/generate-fixtures.mjs` reads, at build time:

- `packages/evals/scenarios.json` — the 100 labelled scenarios
- `packages/evals/report.json` — a real `--model=engine` run
- `packages/engine/src/agentgate_engine/policies/*.md` — the 21 real policies

Every decision, risk score, reasoning string and latency on screen came from
that run. If `report.json` is missing, the analytics layer renders an explicit
"no benchmark data" state rather than a made-up one; if the report is not a
`--model=engine` run, the generator warns and the UI prints a **NOT A PRODUCT
NUMBER** banner.

## Layers

| # | Layer | Route | State |
| --- | --- | --- | --- |
| 1 | The Shield — live action feed | `/` | ships |
| 2 | Evaluation trace | drawer on `/` | ships |
| 3 | Analytics | `/analytics` | ships |
| 4 | Policy control | `/policies` | ships (toggles are local-only) |
| 5 | Human review queue | `/review` | ships |
| 6 | Presenter opener | `/present` | ships |

### The three demo moments

Jump straight to any of them from the Shield's right rail. Each replays its real
scenario, with lead-in context so it lands in situ:

1. **Exfiltration, stopped** — a support agent emails a customer SSN to an
   outside gmail address → **BLOCK**, risk 100.
2. **The split nobody sees** — sub-threshold payments to one vendor, replayed
   with their prior actions so the cumulative pattern is visible.
3. **Caught in four milliseconds** — `DROP TABLE users` → **BLOCK** on the rule
   fast path, no model call.

---

## Design rules

**Glass is the shell. Data surfaces are crisp.**

`.glass` (translucent, `backdrop-filter`) is used **only** on static chrome: the
nav, the trace-drawer frame, the stat-rail panel, the presenter cards. Every
surface carrying live or important data uses `.surface` — opaque, high contrast,
`no-blur`. `backdrop-filter` is expensive and never sits behind live-updating
text or behind the headline benchmark number.

When vibe and legibility conflict, legibility wins. This is projector-first.

**Performance.** Feed cards are `memo()`'d and the list is capped at 60 rows —
both load-bearing during a burst, when the parent re-renders every tick.
Animation is transform/opacity only, so text is never repainted. The **FPS**
button in the Shield's toolbar measures the real frame rate; **Burst ×30**
replays rapidly to exercise it. Measure on the demo machine — don't take a
number on trust.

**Tokens** follow `impeccable.style`: Albert Sans; title 18/600, body 13/400,
meta 12/400; radii 3px pills / 8px fields / 12px cards; rows animate ~380ms with
a small spring overshoot; hover lifts 1px; press scales .96.

**Chart colour is validated, not chosen.** See `lib/chart-tokens.ts` — every
palette was run through the dataviz validator against the `#10131a` chart
surface, and the one residual WARN (escalate↔block, ΔE 7.6 deutan) is documented
along with the secondary encoding that makes it legal: every decision mark
carries an icon *and* a text label, so identity never rests on hue. Every chart
also has a table view.

---

## Live integration

`lib/data/live-provider.ts` is the whole contract boundary. Measured against the
integration branch, not assumed:

| status | endpoint |
| --- | --- |
| **exists** | `POST {gateway}/evaluate` → `{ riskScore, decision, reasoning, violatedPolicy?, latencyMs }` |
| **exists** | `GET {gateway}/health` |
| **exists** | `GET {engine}/policies` — 21 policies |
| **exists** | `GET {engine}/health`, `GET {engine}/sessions/:id` |
| **MISSING** | `GET {gateway}/actions` — the feed |

P1 already writes every decision to D1 `action_logs` with exactly the columns
this dashboard renders, including `decided_by` (the rule-vs-judge split). There
is just no HTTP route to read them back. `rowToEvaluated()` maps that row shape
to the UI's type, so wiring it up is a route, not a redesign.

## Flagged for confirmation before submission

Everything below is shown from mock data and must be checked against the live
backend:

- **Rule-vs-judge path attribution.** The eval report does not record which
  layer answered, so mock mode approximates it from the tool args. Live mode
  uses the gateway's real `decided_by`. Labelled in the UI.
- **Rule-path latency.** Derived, not measured, in mock mode. Live is real.
- **Retrieved policy text.** The engine returns policy *names and scores* only,
  no text, so the trace drawer shows what it has. Raised with P2.
- **The review queue is thin on purpose.** Escalate recall is 9.1% — the engine
  returns `escalate` for 2 of the 22 scenarios labelled that way. The queue
  shows only genuine escalations and states the caveat inline rather than
  padding itself.
