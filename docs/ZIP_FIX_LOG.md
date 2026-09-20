# Zip fix — running log

Every change made while fixing the "Zip returns nothing" problem, in order.
Plan: `ZIP_FIX_PLAN.md`. Branch: `aaryan2`.

Status legend: **done** = coded and tested offline · **unverified** = coded but
needs a live Zip key to prove · **open** = not started.

No live Zip key is available in this environment, so nothing here has been run
against the real API. Everything marked **done** was tested against a mock.

## Baseline

- Started from `main` at `7f3dbd4` plus the two plan docs (`a55fdb2`).
- Engine tests before any change: 77 passed (checked on the previous `main`;
  re-run below).

- Engine tests on updated `main`: **87 passed**.

## Changes

### 1. Engine — config accepts Zip's own variable names · done
`packages/engine/src/agentgate_engine/config.py`

Zip's setup doc names the key `ZIP_API_KEY` and the host `ZIP_API_URL`. The
engine only read `ZIP_API_TOKEN` / `ZIP_API_BASE`, so following the doc left
grounding **silently off** (cause A in the plan). Both spellings now work; the
original names win if both are set.

### 2. Engine — Zip client no longer guesses or goes silent · done
`packages/engine/src/agentgate_engine/zip_client.py`

| Problem | Fix |
| --- | --- |
| An **empty vendor list** was reported as "vendor NOT on the approved list" | Empty is now "Zip's vendor list is empty, so vendor 'X' could not be checked". Only reported as unapproved when Zip returned vendors and none matched |
| A **paginated first page** could falsely prove a vendor missing | If `total` is larger than what came back, the vendor is "status unknown", with the counts |
| A vendor **id** (`vendor_id: v_123`) was compared to display names | Ids are matched first (`id`, `vendor_id`, `external_id`, `uuid`), then names |
| **Nested arguments** (a vendor object, line items) were invisible | Argument search walks nested objects (depth 4). `vendor: {id, name}` resolves to the name |
| Amount only read at the top level | Falls back to summing line-item amounts inside lists; a top-level total is never double-counted with its own items. `"$1,200"` strings now parse |
| Every action called Zip, despite a comment saying financial only | New `is_procurement_action()`; read verbs (`check_`, `get_`, `zip_search_`…) and unrelated tools skip Zip |
| Consulted-but-empty produced a blank | The judge is told: "Zip returned no vendor or budget data for this action — judged on policy alone" |
| No way to tell "off" from "on but empty" | New `zip_status()`: `off` / `on` / `degraded` with a reason. **Never includes the key.** |

Also: `packages/engine/src/agentgate_engine/engine.py` uses the gate and the
no-data line; `packages/engine/server.py` adds `"zip"` to `GET /health` and
prints one startup line (`zip grounding: OFF (…)` / `ON — <host>`).

**Assumption, unverified:** that Zip line items carry amounts under
`amount`/`price`/`total`-style keys. The probe prints the real shape.

**Left unchanged on purpose:** the approvals lookup. `/approvals` may list
approval *instances* rather than "who must sign at this amount", so the
"approval chain requires" line may be misleading. That needs real data to
judge; the probe shows it. Tracked under "Still open".

### 3. Engine — read-only probe · done
`packages/engine/zip_probe.py`

```
./venv/bin/python zip_probe.py
./venv/bin/python zip_probe.py --tool create_purchase_order --args '{"vendor": "Lemongrass Lemon Co", "amount": 400}'
```

Reports which variable **names** are set, whether `/vendors` and `/approvals`
are OK / EMPTY / AUTH FAILED / UNREACHABLE (with counts and the first names),
what the engine would extract from a sample call, and the exact facts the judge
would see. Ends with one verdict naming the cause. Exit code 0 only when
grounding works.

Output against a **mock** populated company (not real Zip data):

```
  host           https://staging-api.zip.com
  /vendors       OK   total=1   Lemongrass Lemon Co
  /approvals     OK   total=1   ?
  sample call    create_purchase_order {"vendor": "Lemongrass Lemon Co", "amount": 400}
                 asks Zip? yes
                 facts the judge would see:
                   - vendor 'Lemongrass Lemon Co' is on the approved vendor list
                   - Zip's approval chain at this amount requires: Department Head
verdict: Zip grounding is working (budgets are unreadable in Zip: see item 14).
```

With no key set it prints `grounding is OFF. Set ZIP_API_KEY (or ZIP_API_TOKEN) in .env.`

### 4. Engine tests · done
`packages/engine/tests/test_zip.py` (+16), `tests/test_zip_probe.py` (+6, new)

Covers: empty list not reported unapproved; genuinely missing vendor still
flagged; pagination; id match; nested vendor/amount; line-item sum; no double
count; procurement-vs-read tool gate; both variable spellings and precedence;
status off/on/degraded and no key leak; engine states "no data" instead of
blank; non-procurement actions never call Zip; probe verdicts (working, empty
company, no key, auth failure, non-procurement tool) and that the key is never
printed.

**Engine suite: 87 → 109 passed.**

### 5. Gateway — `zipFacts` now survives · done
`evaluate.ts`, `engine.ts`, `handler.ts`, `action-log.ts`, `policies.ts`,
`migrations/0003_zip_facts.sql`

The engine already returned `zipFacts`; the gateway threw it away (cause B). Now:

- `Verdict.zipFacts?: string[]`; `parseEngineResult` reads `zipFacts` or `zip_facts`.
- `null` from the engine (Zip not consulted) leaves the field **absent**, not an
  empty list, so "not consulted" and "consulted, found nothing" stay distinct.
  Non-string or empty entries are dropped.
- Written to D1 (`zip_facts` column) and to the in-memory feed behind
  `GET /actions`, **PII-masked** with the existing `maskPii`.
- New migration `0003_zip_facts.sql`.

**Deploy order matters.** Apply `0003` to D1 **before** deploying the Worker.
Until the column exists, the audit `INSERT` and the `/actions` `SELECT` both
fail, and audit failures are swallowed, so rows would silently go missing:

```
cd packages/gateway
npx wrangler d1 migrations apply agentgate --local     # dev
npx wrangler d1 migrations apply agentgate --remote    # then deploy
```

### 6. Gateway — Zip's MCP server launched the way Zip documents · done
`zip-upstream.ts` (new), `mcp.ts`

`mcp.ts` hardcoded `~/.local/bin/ziphq-mcp`, which exists only after a separate
`uv tool install`. It now picks, in order: `ZIP_MCP_COMMAND` → `uv run --with
ziphq-mcp ziphq-mcp` (Zip's doc; `uv` is searched on the PATH and in the usual
install dirs, since Claude Desktop's PATH is minimal) → the old binary. If
nothing is installed it names `uv` and says how to fix it.

`npm run mcp -w packages/gateway -- zip` now **refuses to start** with a clear
message when `ZIP_API_KEY` or `ZIP_API_URL` is missing, and warns when
`ZIP_MCP_MODE` is not `readwrite` (which hides the write tools: ~60 read tools
instead of 131). Logs how it launched Zip.

### 7. Gateway — `.env` was never read · done
`env-file.ts` (new), `mcp.ts`

Found while doing item 6: the gateway does not load `.env`, so a `ZIP_API_KEY`
placed there (where the setup says to put it) was invisible to the MCP proxy
and `ziphq-mcp` started unconfigured. `mcp.ts` now reads **`ZIP_*` variables
only** from the repo `.env` for the `zip` server. An already-set variable wins.
It logs the variable **names** it read, never values. Not applied to other
settings on purpose, to avoid changing unrelated gateway behaviour as a side
effect.

### 8. Config and docs · done
- `.env.example`: Zip block (`ZIP_API_URL`, `ZIP_API_KEY`, `ZIP_MCP_MODE`,
  optional `ZIP_MCP_COMMAND`), placeholders only, with the header/host warnings.
- `packages/engine/ZIP.md`: removed the resolved "token is being rejected"
  section; added "Why grounding can come back empty" (cause table + behaviours);
  configuration table lists both variable names.

### 9. Gateway tests · done
`engine.test.ts` (+1), `worker.test.ts` (+1), `zip-upstream.test.ts` (+10, new)

Covers: `zipFacts` kept / snake_case / null and junk dropped; D1 insert has the
column, one placeholder per value, masks an email inside a fact, stores NULL
when Zip was not consulted; launcher order, minimal-PATH search, explicit
override, missing-uv message; preflight names each missing variable; read-only
warning; `.env` parsing (export, quotes, comments); only `ZIP_*` loaded, no
override, names not values, missing file is fine.

### 10. Either pair of variable names works for the MCP proxy too · done
`zip-upstream.ts` (`aliasZipEnv`), `mcp.ts`, `zip-upstream.test.ts` (+3)

The engine reads `ZIP_API_TOKEN` / `ZIP_API_BASE`; `ziphq-mcp` and Zip's doc use
`ZIP_API_KEY` / `ZIP_API_URL`. A `.env` written for one pair made the launcher
refuse to start for the other. `npm run mcp -- zip` now fills whichever pair is
missing from the one that is set, **in memory only** (nothing is written to
disk), strips a trailing slash from the host, never overrides a value that is
already set, and logs the **names** it filled, never values.

Checked with fake values and only the engine-style names set: it logs
`filled ZIP_API_KEY, ZIP_API_URL from its counterpart` and gets past preflight.

**Key handling note.** The real key was pasted into the chat during this work.
It was not written to any file or used by Claude. Treat it as exposed and rotate
it after the demo.

## Verification

| Check | Result |
| --- | --- |
| Engine suite | **113 passed** (was 87) |
| Gateway suite | **123 passed** (was 108) |
| Typecheck: shared-types, observability, evals, demo-agents, gateway | clean |
| `npm run mcp -- zip` with no key | refuses with a clear list of what is missing |
| `zip_probe.py` with no key | `grounding is OFF. Set ZIP_API_KEY…` |
| Anything against the **real** Zip API | **not run — no key here** |

Nothing is committed yet.

## What to do next (needs your key)

1. Put `ZIP_API_URL`, `ZIP_API_KEY`, `ZIP_MCP_MODE=readwrite` in the git-ignored `.env`.
2. Install `uv` (`brew install uv`).
3. Run `cd packages/engine && ./venv/bin/python zip_probe.py` and read the verdict.
4. If it says the company is empty, run Zip's demo workflow once by hand.
5. Apply migration `0003` before deploying the Worker (see item 5).

## First contact with the real Zip API

Run after the setup steps (uv installed, engine venv built with Python 3.12:
109 engine tests pass there). Key from `.env`, never printed. All calls read-only.

`zip_probe.py` verdict: **auth works, but the company looks empty.**

Raw read-only counts (`GET`, `Zip-Api-Key` header, `staging-api.zip.com`):

| Endpoint | HTTP | total |
| --- | --- | --- |
| `/vendors` | 200 | **0** |
| `/requests` | 200 | **0** |
| `/approvals` | 200 | **0** |
| `/invoices` | 200 | **0** |
| `/users` | 200 | 1 |
| `/departments` | 200 | 8 (IT, People, Legal, Operations, Sales, Marketing, Finance, Engineering) |
| `/subsidiaries` | 200 | 3 (Greenbax, **Zip - Modern Spend Approvals**, Honeycomb Manufacturing Inc.) |
| `/purchase-orders`, `/bills` | 404 | route does not exist |

What this establishes:

- **Cause A is not the issue** (key and host are right) and the header is right.
- It **is** the company from Zip's doc: the subsidiary `Zip - Modern Spend Approvals` exists.
- Zip's doc treats the vendor `Lemongrass Lemon Co` as already existing, yet
  `/vendors` returns 0. So "run the demo workflow to seed data" (this plan's
  earlier advice) may be wrong. Either the vendor is not visible through the
  REST list, or this company simply has none. **Not yet resolved.**
- Correction to the earlier plan: it said an empty result meant "run the demo
  once". That is one possibility, not the established fact.

## What Zip's Postman collection established

Source: the collection Zip supplied, provided as `first.json.pdf` (649 pages).
It is **truncated**: the export stops partway through the "Requests" section, so
everything after it (Subsidiaries, Users, **Vendors**, …) is missing. Named
`first`, so a second part may exist. 85 endpoints in 31 folders were readable.
The collection itself is kept out of the repo (Zip's file, 1.2 MB).

- **Header confirmed:** `Zip-Api-Key` (security scheme `apikey`).
- **Purchase orders are `/purchase_orders`** (underscore). Earlier probing tried
  `/purchase-orders` and read the 404 as "does not exist". Wrong guess, not a
  missing feature. `GET /purchase_orders?vendor_id=…` returns `total_amount`,
  `amount_billed`, `status`, `vendor`, `request_number` — enough to compute real
  open commitments per vendor. Not built yet.
- **Budgets are write-only over REST:** only `PUT /budgets` and
  `PUT /budget_actuals`. (Superseded by item 14: the MCP tool hits the same route and also gets 405.)
- **`/approvals` is not an approval chain.** It searches approval *steps on
  requests* (filters: `request_number`, `status`, `node_type`, `config_type`,
  dates; records carry `assignee`, `request_number`, `display_status`). It never
  says who must sign at an amount.
- **`/requests`, `/invoices`, `/purchase_orders` support server-side filters**
  (`vendor_id`, `vendor_name`, `request_number`, dates…) and pagination
  (`page_size`, `page_token`, `next_page_token`).
- **No REST create for requests or purchase orders.** Requests are only
  searched (`GET`) and updated (`PATCH`); the doc's demo creates them in the UI
  or through the MCP server.
- Invoices: `GET/POST /invoices`, `PATCH …/paid_status`,
  `PATCH …/send_bill_invoice_for_approval` (the doc's "bill" flow).
- The sample invoice (`invoice.pdf`): Lemongrass Lemon Co, one $1,000 line item,
  due 10/18/2026.

### 12. Approval status codes named, and more of the company mapped · done
`zip_client.py` (`_APPROVAL_STATUS`), `tests/test_zip.py`

A second paste of the Postman collection (A to "Option Filter Rules"; still no
Vendors section) documents the numeric approval `status`: 0 Upcoming, 1 Ready to
start, 2 Rejected, 3 Approved, 4 Approved automatically, 5 Canceled, 6-8 custom
(named in `node_status`). `_describe_step` now uses Zip's `display_status`, then
the custom name, then this map, so the judge reads "Ready to start" not "1".
**Engine suite: 111 passed.**

More read-only counts (correct routes this time, key never printed):

| Route | total |
| --- | --- |
| `/purchase_orders`, `/agreements`, `/expense_categories`, `/item_accounts`, `/locations` | 0 |
| `/vendors`, `/vendors?name=Lemongrass`, `/requests?vendor_name=Lemongrass` | 0 |
| `/purchase_categories` | 13 |
| `/payment_terms` | 61 |
| `/gl_codes` | 12 |
| `/lookups` | 17 |
| `/event_logs` | 4 |
| `/agent_sessions` | 404 (Superagents not enabled) |

So the company is **configured but has no transactional data**: no vendors, POs,
requests or invoices. Searching vendors by name finds no Lemongrass Lemon Co.
Most likely the demo workflow has to be run once to create it. `/vendors?status=1`
returns 400, so that filter is not accepted on this route.

### 13. Vendor status: the real enum, and a bug it exposed · done

The complete Postman export (`full.pdf`, 1086 pages) includes the Vendors section the earlier
exports cut off. What it settled:

- `GET /vendors` **does** take filters: `name`, `status`, `subsidiary_id`, `department_id`,
  `last_updated_after/before`, `sort_by`, `sort_order`, `page_size` (max 100), `page_token`.
  Earlier notes saying "no server-side search" were wrong for vendors.
- A vendor's `status` in the response is a **number**; the filter takes words. The API's own 400
  lists them: `INITIAL, ACTIVE, PREFERRED, INACTIVE, BANNED, DRAFT, DELETED`. The collection does
  not say which number is which.
- **Bug found in our client:** it compared `status` to words ("approved", "active"), so a real
  vendor with a numeric status would have been reported as *NOT on the approved vendor list*.
  Now: a number is "unknown" plus a note with the raw code; ACTIVE/PREFERRED = approved;
  INACTIVE/BANNED/DELETED = not approved; INITIAL/DRAFT = not approved, "not yet onboarded".
  Tests: `TestVendorStatus`. Engine suite: 113 passing.
- **Live check (read-only):** `/vendors` returns total 0 for *every one of the 7 statuses* and for
  `name=Lemon`. The company genuinely has no vendors; the empty result is not a hidden filter.

### 14. Zip's real MCP server run end to end (read-only) · done

`packages/gateway/src/zip-mcp-probe.ts` (`npm run zip:probe -w packages/gateway [-- <tool> '<json>']`)
starts Zip's server through the gateway's own launcher and lists tools. It only calls
get/list/search tools and refuses anything else.

- `uv run --with ziphq-mcp ziphq-mcp` downloaded and started (ziphq-mcp 4.0.5).
- **131 tools, 60 read-only** — readwrite mode is active, the `.env` names reach the server.
- `zip_search_vendors`, `zip_search_purchase_orders`, `zip_search_requests` → `total 0`, matching REST.
- **`zip_search_budgets` → `HTTP 405`.** It wraps the same `GET /budgets` REST route, so budgets
  are unreadable through MCP too. This corrects the earlier claim (ZIP.md, items above) that
  budgets are readable via MCP; ZIP.md is fixed. The tool only takes `page_size`/`page_token`.
  Consequence: budget lines in the judge's facts cannot come from Zip in this environment.

### 15. Following Zip's setup doc step by step · done (diagnosis) / waiting on UI steps

`packages/engine/zip_demo_check.py` walks the doc's steps against the live API and names the
first one missing. Live result today: setup step passes; **steps 1-7 all not done** (0 requests,
0 vendors, 0 POs, 0 invoices).

What the walk found:
- **The key is for the right company** (has the doc's subsidiary `Zip - Modern Spend Approvals`;
  one user, the key owner). Nothing is wrong with the key, host, header or MCP setup.
- **What is "going wrong" is simply that demo steps 1-7 were never run.** The vendor
  Lemongrass Lemon Co is not in `/vendors`; it most likely only appears in the request form's
  vendor picker and becomes a company vendor when a request uses it (step 1.4). Unverified.
- **API coverage of the doc:** no `create_request` and no approve tool exist, so steps 1, 2 and 6
  are UI-only. Writable through MCP: `zip_upsert_vendor`, `zip_create_purchase_order`,
  `zip_create_invoice`, `zip_send_invoice_for_approval`, `zip_update_invoice_paid_status`.
- Tests: `tests/test_zip_demo_check.py`.

### 16. Zip's full Postman collection recovered from the PDF · done

`full.pdf` (1086 pages) was converted back to `Zip Public APIs.postman_collection.json` (in
Downloads, not in git: it is Zip's file). Method: `pdftotext -raw`, then a string-aware tokenizer
(whitespace outside strings is insignificant in JSON; only line wraps inside strings needed a
space-or-not decision). Result: valid JSON, 45 folders, **153 requests, 862 response examples**;
every request URL agrees with its own host/path/query; no broken ids; no description variants.
Not byte-identical to Zip's file: extra spaces inside example bodies are not recoverable.
Vendor status numbers are still undocumented in it (a *location* status lists 0 INITIAL, 1 ACTIVE,
3 DELETED, which hints at the family but is not proof for vendors).

### 17. First real vendor: Lemongrass Lemon Co (created in the UI) · done

Created by hand in Zip (Vendors -> Vendor records). The request form's vendor picker is
**required and only lists existing vendors**, so the company needed one before step 1 could run.
Read back through the API:
- `status` **5 = DRAFT** (verified: `?status=DRAFT` returns it). Client now maps that one code;
  others stay "unknown" rather than guessed. Draft = "not yet onboarded" for the judge.
- `GET /vendors?name=Lemongrass` returns 0 while the full name matches: **`name` is an exact
  match filter, not a substring search.**
- A draft vendor may not appear in the request picker until activated.

### 18. Demo steps 1-3 done in Zip; grounding proven on real data · done

State read from the live API after the UI steps:
- Vendor Lemongrass Lemon Co: `status` **1 = ACTIVE** (verified: `?status=ACTIVE` returns it), after
  being **5 = DRAFT**. Client now maps codes 1 and 5 only.
- 3 requests: #1 (PURCHASE_REQUEST, approved, status 3), #2 (in progress; steps "Finalize request
  details" and "Self approve", both Ready to start), and an auto-created GOODS_RECEIVING request.
- 1 purchase order (PO 1), vendor Lemongrass. 0 invoices (bill steps not needed).
- `zip_probe.py` on a Lemongrass create_purchase_order now shows the judge real facts: the vendor
  and Zip's approval steps on request 2 ("Ready to start (Japneet Singh)"). Budget is the only
  missing fact, and is unreadable in Zip (item 14).
- Fixed a stale probe message that still claimed budgets came via MCP. Engine suite: 118.

### 19. Real actions judged end to end with live Zip facts · done (engine level)

Engine started locally (`/health`: `zip.state: on`, `openaiConfigured: true`) and three
`create_purchase_order` actions sent to `/evaluate` (session `zipdemo-<timestamp>`):

| Action | Decision | Zip facts the judge saw |
| --- | --- | --- |
| Lemongrass Lemon Co, $400, request 2 | **escalate 30** (Approval Chain Integrity) | vendor on the approved list; request 2 steps "Finalize request details / Self approve — Ready to start (Japneet Singh)" |
| Shady Supplies LLC, $400 | **block 70** (Vendor and Payee Verification) | vendor NOT on the approved vendor list |
| Lemongrass Lemon Co, $25,000 | **block 70** (Single Transaction Limit) | same facts as row 1 |

Row 1 is the point: $400 is under every stated limit, and it still escalates because Zip says the
request has not been approved. Not yet run: the gateway leg (needs migration 0003 applied to D1
before `zip_facts` can be stored).

### 20. Zip work moved onto the latest main (`zip-integration`) · done, uncommitted

`main` (the live app) had moved to `1aac593` (durable D1 audit log, one-command demo, dashboard
stage). Our uncommitted work was stashed from `aaryan2` and re-applied on a new branch
`zip-integration` cut from `origin/main`. `aaryan2` is untouched.
- Conflicts: one, `action-log.ts` (main refactored the row push/sink; our `zip_facts` line added
  inside it). `handler.ts` and `mcp.ts` merged automatically.
- `d1-log.ts` (new on main) now also writes `zip_facts`. Because main is live, it **falls back to
  the old column set if D1 says `zip_facts` does not exist yet**, so merging before migration 0003
  cannot lose audit rows. Unrelated D1 errors still surface. Tests: `d1-log.test.ts`.
- Suites on the new branch: gateway **126 passed**, engine **118 passed**, `tsc` clean.
- Still to do before merging: apply migration 0003 to D1 (additive, one nullable column).

### 21. Verified on the merged branch; two more real bugs found and fixed · done

Local verification on `zip-integration` (nothing shared: migration applied with `--local`, engine
and gateway started without Cloudflare credentials, so storage was in-memory).

Found and fixed:
- **`demo.sh` blanked only `ZIP_API_TOKEN`.** The engine now also accepts `ZIP_API_KEY`, so a `.env`
  using Zip's own name would switch Zip on in the default (Zip-off) demo. Both are blanked now.
- **Zip's MCP write tools take one `data` argument that is a JSON *string***
  (`zip_create_purchase_order`: "JSON string. Required: vendor_id, currency"). The engine's lookups
  and the gateway's spend-limit rule both read nothing inside it. The engine (`_expand`,
  `_nested_amount`) and the gateway (`collectFields`) now decode it. Tests added in both.

Real path, MCP client -> gateway -> Zip's live MCP server (131 tools), engine judge on localhost:

| Call | Result |
| --- | --- |
| `zip_search_vendors` (read) | allowed, returned the real vendor (status 1) |
| `zip_delete_vendor` (nil GUID) | blocked by the judge, risk 70 |
| `zip_create_purchase_order`, `data` = JSON string with amount 25000 | **blocked by the rules in 2 ms**: `"data.amount" is 25000, limit is 500` |
| `zip_create_purchase_order`, unknown `vendor_id`, $400 | blocked by the judge + Zip, risk 70: not on the approved vendor list |

Zip afterwards: vendors 1, purchase orders 1, requests 3, invoices 0, unchanged.
Suites: gateway 127 passed, engine 121 passed, `tsc` clean. Still uncommitted.

### 11. Approvals no longer mislabelled · done
`zip_client.py`, `tests/test_zip.py` (replaced 1 test, +2), `ZIP.md`

Was: the client fetched `/approvals` for any purchase with an amount, took
whichever records came back (across **all** requests), and told the judge
"Zip's approval chain at this amount requires: …" as authoritative fact. Per the
collection that is false, and would have misled the judge.

Now: approvals are asked **only when the tool call carries a request number**
(`request_number` / `request_id`), scoped with `?request_number=`. The judge is
told `Zip's approval steps on request R-1042: Department Head — Pending (Ana Diaz)`.
Assignee **names only** (an email would reach logs and the screen). Zip's numeric
`status` code is not interpreted; `display_status` (Zip's own wording) is used.
No steps → "Zip has no approval steps recorded on request R-9". No request
number → approvals are not consulted at all. `approvers_required` was removed.

Tests: steps are scoped by request number; never asked without one; empty case
is stated; emails never appear. **Engine suite: 111 passed.**

Next check (needs OK to download `ziphq-mcp` via `uv`): use the MCP tools
`zip_search_vendors` / `zip_search_budgets` (read-only) to see whether the vendor
and budgets are visible there even though the REST list is empty. That also
gives the real tool names and argument shapes (plan Phase 2).

## Still open

- **Dashboard "What Zip knew"** section. `zip_facts` now reaches D1 and
  `GET /actions`, but no UI reads it yet.
- **Budget grounding cannot come from Zip** here: REST and `zip_search_budgets` both 405 (item 14).
  Options: drop the budget lines from the Zip story, or seed a budget in a local file.
- Cumulative limit (`limits.py`) only sums a top-level field, so it may not
  fire on nested Zip line items.
- **Vendors:** why `/vendors` returns 0 while Zip's doc treats Lemongrass Lemon
  Co as existing. The collection is truncated before the Vendors section. Needs
  either the remainder of the collection ("second" part?), the Vendors page in
  Zip's UI, or the MCP `zip_search_vendors` tool.
- **Open commitments** from `GET /purchase_orders?vendor_id=` (see collection notes).
- Only the connection and empty-company results above were seen against the
  real Zip API. Vendor, budget and approval grounding on real data is untested.
