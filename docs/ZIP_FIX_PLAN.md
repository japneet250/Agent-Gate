# Zip returned nothing — diagnosis, fix plan, expected output

Companion to `ZIP_INTEGRATION_PLAN.md`. That plan says what to build. This one
says why the existing integration comes back empty and how to fix it.

**Status: not yet run against a live Zip key.** The findings below marked
"reproduced" come from a mock Zip API; the rest are read from the code. Step 1
of the plan exists to find out which cause is yours.

## Why it can be empty

"Empty" can happen at five different points, and they look identical from the
outside. Most likely first.

| # | Cause | Evidence | Effect |
| --- | --- | --- | --- |
| A | **Grounding is silently off.** The engine only calls Zip if `ZIP_API_TOKEN` is set (`zip_configured()`). Zip's own doc names the key `ZIP_API_KEY`. | `config.py`, `zip_client.py`. `.env.example` has no Zip variables. | `zipFacts` is `null`. No error anywhere. |
| B | **The facts are dropped after the engine.** The engine returns `zipFacts`, but the gateway's `Verdict` type has no such field, D1 has no column, and the dashboard never reads it. | `git grep zipFacts -- packages/gateway apps/dashboard` finds nothing. | Even a correct answer shows up as nothing. |
| C | **The arguments do not name a vendor.** The client looks for a top-level `vendor`/`supplier` name and an `amount`. With neither, it asks Zip nothing. | **Reproduced:** args `{"amount": 400}` against a populated Zip give `NOTHING (zipFacts=None)`. | Empty for any call that carries only ids or nested line items. |
| D | **The company has no data.** Zip's own `ZIP.md` shows the key working and returning `{"list":[],"size":0,"total":0}`. A fresh staging company may have no vendors or approvals until the demo workflow is run once. | `ZIP.md`. | Empty lists, so no facts. |
| E | **Budgets are never read.** `GET /budgets` is 405, and the MCP path is not implemented. | `CONTEXT.md`, `zip_client.py` | The budget half is always absent. |

### Two related bugs that make it worse, not emptier

Reproduced with the mock:

- **Empty company, vendor named:** the output is `vendor 'Lemongrass Lemon Co' is
  NOT on the approved vendor list`. The vendor exists in Zip's demo, but the
  list was empty, so the client concludes it is unapproved. A false alarm, not
  a blank.
- **Zip-shaped args with an id:** `{"vendor_id": "v_123", ...}` gives `vendor
  'v_123' is NOT on the approved vendor list`. The client compares an **id**
  to vendor **names**, so a real, approved vendor is reported as unapproved.

Also read from the code, not reproduced:

- `_approval_chain` returns whatever `/approvals` lists, whatever the amount.
  That endpoint holds approval **instances**, not "who must sign at this
  amount", so the "approval chain requires" line is unreliable.
- `engine.py` says it consults Zip "only for money-moving tools", but there is
  no such check. Every action calls Zip, adding latency to actions that have
  nothing to do with money.

## Fix plan

Ordered so each step tells you something. Do not skip step 1.

### Step 1 — Find out which cause is yours (about 15 min, read-only)

Add `packages/engine/zip_probe.py`. It prints a status per source and never
prints the key.

- [ ] Report which of `ZIP_API_KEY` / `ZIP_API_TOKEN` / `ZIP_API_URL` /
  `ZIP_API_BASE` are set, **names only**. Catches cause A.
- [ ] Call `GET /vendors` and `GET /approvals` with the `Zip-Api-Key` header and
  print status, `total`, and the first few names. Separates D (empty company)
  from an auth problem.
- [ ] Call the MCP tool `zip_search_budgets` through `ziphq-mcp` and print what
  it returns. Confirms E and shows the real budget shape.
- [ ] Feed the probe one real call from the Zip demo (Phase 2 of the main plan)
  and print the assembled facts. Catches C.

### Step 2 — Fix the silent failures (small, safe)

- [ ] **Accept both variable names.** `config.py`: `ZIP_API_TOKEN` falls back to
  `ZIP_API_KEY`, `ZIP_API_BASE` to `ZIP_API_URL`. Add both to `.env.example`.
  Fixes A.
- [ ] **Never be silently off.** `GET /health` reports `zip: on | off (no key) |
  degraded (why)`. Log one line at startup saying which. Same pattern as the
  existing `retrieval` field.
- [ ] **Stop guessing vendors.** Empty list means "no data", not "not approved".
  Only report "NOT on the approved vendor list" when Zip returned records and
  none matched. Say "vendor list is empty" otherwise.
- [ ] **Match by id as well as name.** Compare a `vendor_id`-style argument
  against record ids before falling back to names.
- [ ] **Only ask Zip about financial actions**, as the comment already claims.
- [ ] Tests for each: empty company, id-only args, non-financial action, key
  under the doc's name.

### Step 3 — Seed the company (you, about 20 min)

If step 1 shows an empty company, run Zip's demo workflow once by hand: create
the request for `Lemongrass Lemon Co`, finalize it, create the bill, approve
it. That leaves one vendor, one PO and one approval for the grounding to find.
Keep it to one run; the instance may be shared.

### Step 4 — Make the result reach a human

- [ ] Add `zipFacts` to the gateway `Verdict`, pass it through `engine.ts`,
  store it (redacted) in D1, and render it in the dashboard trace drawer.
  Same work as Phase 4 of the main plan.

### Step 5 — Budgets through MCP

Phase 3 of the main plan. Do this last: it needs the real budget shape from
step 1.

## Expected output

Illustrative. The names come from Zip's demo doc; the numbers are examples, not
measurements. Real output is only known once step 1 runs against your key.

### The probe (step 1), healthy case

```
Zip probe
  env            ZIP_API_KEY set, ZIP_API_URL set, ZIP_API_TOKEN set (fallback ok)
  auth           OK   (Zip-Api-Key header, staging-api.zip.com)
  /vendors       OK   total=1   Lemongrass Lemon Co (active)
  /approvals     OK   total=1
  budgets (MCP)  OK   1 match  "Zip - Modern Spend Approvals"
  sample call    create_purchase_order {vendor: "Lemongrass Lemon Co", amount: 400}
     facts:
       - budget 'Zip - Modern Spend Approvals': USD 9,600 remaining of 10,000 (4% already committed)
       - this action would bring the budget to 8% of its total
       - vendor 'Lemongrass Lemon Co' is on the approved vendor list
verdict: Zip grounding is working.
```

### The probe, the cases you have probably been hitting

```
  env            ZIP_API_KEY set, ZIP_API_TOKEN NOT set   <- cause A
verdict: grounding is OFF. Set ZIP_API_TOKEN (or upgrade to the fallback).
```

```
  /vendors       OK   total=0                              <- cause D
  /approvals     OK   total=0
verdict: auth works but the company is empty. Run the demo workflow once.
```

```
  sample call    create_purchase_order {vendor_id: "v_123", amount: 400}
     facts:      (none)                                     <- cause C
verdict: arguments carry an id, not a name. Match by id (step 2).
```

### What the engine returns (after step 2)

```json
{
  "riskScore": 70,
  "decision": "block",
  "reasoning": "A $4,000 purchase order would take 'Zip - Modern Spend Approvals' to 141% of its budget, and the vendor is not on the approved list.",
  "violatedPolicy": "Budget Exhaustion",
  "zipFacts": [
    "budget 'Zip - Modern Spend Approvals': USD 2,100 remaining of 10,000 (79% already committed)",
    "this action would bring the budget to 121% of its total — this would take it OVER budget",
    "vendor 'Acme Supplies' is NOT on the approved vendor list"
  ]
}
```

### What the agent sees through the gateway

```
This action was blocked because: A $4,000 purchase order would take
'Zip - Modern Spend Approvals' over its budget, and 'Acme Supplies' is not an
approved vendor.
```

### What the dashboard shows (after step 4)

A blocked action's trace drawer gains a section:

```
What Zip knew
  Budget    Zip - Modern Spend Approvals   79% used → 121% if approved
  Vendor    Acme Supplies                  not approved
  Approvers (from Zip)                     Department Head
```

### The empty-facts case, done properly

When Zip has nothing useful, the output should say so instead of staying blank
or guessing:

```
zipFacts: ["Zip returned no vendor or budget data for this action — judged on policy alone"]
```

## Done when

- The probe prints a clear verdict for each source and never prints the key.
- With only the doc's variable names set, grounding turns on.
- An approved vendor is never reported as unapproved because of an id or an
  empty list.
- A blocked Zip action shows real Zip facts in the dashboard.
- A run with no Zip data says so explicitly.
