# Zip integration

Zip runs the purchasing workflow: budgets, approval limits, vendors, policy, and
the people who sign off. AgentGate governs what an agent is allowed to *do*
inside it.

Two integrations, at different layers.

---

## 1. AgentGate in front of Zip's MCP server

Zip ships `ziphq-mcp`, run locally through `uv`. It exposes **131 tools — 66 of
them write or destroy**: `zip_delete_user`, `zip_delete_vendor`,
`zip_upsert_budgets`, the whole request/PO/invoice/approval surface. An agent
pointed straight at it has all of that reach with nothing in between.

AgentGate is an MCP proxy, so it sits in the middle:

```
Claude / Cursor / your agent
        │  stdio (MCP)
        ▼
  AgentGate gateway ──► rules (~1ms) ──► engine judge (~2s)
        │  HTTP (MCP)
        ▼
  Zip's remote MCP server
```

```bash
uv tool install ziphq-mcp          # once

export ZIP_API_URL=https://staging-api.zip.com
export ZIP_API_KEY=<your key from {your-domain}/manage/api-key>
export ZIP_MCP_MODE=readwrite      # without this you get 60 read tools, not 131

npm run mcp -w packages/gateway -- zip
```

Verified against Zip's real server:

```
AgentGate mirroring 131 Zip tools (66 of them write/destroy)

  REFUSED  3269ms  zip_delete_vendor   "a destructive operation"
  REFUSED  2503ms  zip_delete_user     "a destructive operation"
  REFUSED  1811ms  zip_upsert_budgets  "$999,999,999 exceeds the limit"
```

A remote MCP server over HTTP or SSE also works — pass a URL instead of a server
name, with `AGENTGATE_UPSTREAM_TOKEN` for auth.

The agent sees Zip's real tools, unchanged. Every call is evaluated first.

**The agent never holds a Zip credential.** Only AgentGate does. An agent cannot
route around the firewall by calling Zip directly, because it has nothing to
call Zip with. That property is the reason to put the proxy here rather than
inside the agent.

---

## 2. Judging with Zip's real state, not a guess

A markdown policy can only say "over $500 needs approval". Zip knows what budget
this draws on, how much is left, whether the vendor is onboarded, and who has to
sign.

Set `ZIP_API_TOKEN` and financial actions are grounded before the judge sees
them:

```
budget 'Marketing Q3': USD 2,100 remaining of 80,000 (97% already committed)
this action would bring the budget to 102% of its total — this would take it OVER budget
vendor 'Northwind Media' is NOT on the approved vendor list
Zip's approval chain at this amount requires: Requester, Department Head
open commitments not yet invoiced: 15,000
```

The same $4,000 purchase order, judged twice:

| | decision | reasoning |
| --- | --- | --- |
| **without Zip** | escalate 30 | "exceeds the $500 limit for single transactions" |
| **with Zip** | **block 70** | "would take the 'Marketing Q3' budget over its total… 'Northwind Media' is not on the approved vendor list" |

And it cuts the other way: a **$180** order — trivially under every stated limit
— escalates when Zip shows the budget is already 97% committed. No threshold in
any policy file could catch that.

### Configuration

| variable | default | status |
| --- | --- | --- |
| `ZIP_API_TOKEN` | — | required; empty disables grounding entirely |
| `ZIP_API_BASE` | `https://staging-api.zip.com` | verified working |
| `ZIP_VENDORS_PATH` | `/vendors` | verified, returns live data |
| `ZIP_APPROVALS_PATH` | `/approvals` | verified |
| `ZIP_BUDGETS_PATH` | `/budgets` | **not readable over REST** — see below |

### The header is `Zip-Api-Key`, not `Authorization: Bearer`

This cost a round of debugging worth writing down. With `Authorization: Bearer`
the API answers:

```
{"message":"The provided API key is not valid"}
```

which reads like a bad key and is not. The key was fine the whole time:

```
Zip-Api-Key: <key>   ->   {"list":[],"size":0,"total":0}
```

Responses are enveloped as `{"list": [...], "size": n, "total": n}`, and the
collection endpoints **reject unknown query parameters with a 400** rather than
ignoring them — so there is no `?q=` to search with. Filtering happens client
side.

### Budgets are not readable over REST

`GET /budgets` returns 405 with `Allow: OPTIONS, PUT`. So does every variant
tried (`/budget-actuals`, `/budgets/search`, `POST /budgets`). Budget state lives
behind their **MCP** server instead, as `zip_search_budgets`.

The client notices the 405 once and stops asking, rather than paying for the
round trip on every financial action and flagging the context degraded for a
call that can never succeed. Restoring the budget half of the grounding means
reading it through MCP — the gateway already holds an MCP connection to Zip, so
that is where it belongs.

### What probing the live API established

A 401 means the route exists and only the key was rejected; a 404 means it does
not exist. Against `api.ziphq.com`, which answers "Welcome to Zip API!" at the
root:

```
/vendors           401   exists
/requests          401   exists
/approvals         401   exists
/departments       401   exists
/users             401   exists
/budgets           405   exists, but Allow: OPTIONS, PUT — no GET
/purchase-orders   404
/approval-chains   404   (my original guess)
/cost-centers      404
/me                404
```

**`/budgets` does not answer GET.** Budget state may live under a different
route, or be reachable only once authenticated well enough to read their docs.
That is the one piece of the grounding story still unresolved.

### The token is being rejected

```
no auth header  →  {"message":"Missing API Key","code":"UNAUTHORIZED"}
with our token  →  {"message":"The provided API key is not valid"}
```

The API distinguishes the two, so it is parsing the key and refusing it. Tried
as `Authorization: Bearer`, `Authorization: Token`, bare `Authorization`,
`X-Api-Key` and `x-zip-api-key` — all 401. The key is 38 characters, which may
mean it is truncated.

**Ask Zip for:** a working key for the company they provisioned, the header they
expect, and whether there is a sandbox host. `api-sandbox.ziphq.com` redirects
to `api-sandbox.zip.com`, which 404s.

The three lookups run concurrently, because the judge is on a latency budget.
Every one fails soft: Zip unreachable degrades to policy-only reasoning and says
so in the prompt, rather than taking the firewall down.

**Paths are configurable because they are unverified.** The client is built and
tested against a mock shaped like Zip's documented API; it has not been run
against the real one. Expect to adjust the paths and the response shape on first
contact.

---

## 3. The thing a single approver cannot see

Zip's own framing: *"Approval thresholds assume a human pace, so ten thousand
individually compliant approvals can add up to something nobody would have
signed off on."*

That is the cumulative detector, and it is not Zip-specific — it is how
AgentGate works. Thirty $400 purchase orders, each legal, each under every
threshold:

```
#1   $   400 approved   risk 0
...
#12  $ 4,800 approved   risk 0
#13  ESCALATE — Cumulative Spending Limit: $5,200 across 13 actions this
     session exceeds the limit of $5,000. Pattern: approval-threshold splitting.
```

The limit is declared in a policy file, so a Zip customer sets their own:

```markdown
Accumulate: sum(toolArgs.amount)
Applies to: financial
Limit: $5,000
When exceeded: escalate
```

---

## Policies added for procurement

`budget-exhaustion.md` — a purchase that takes a real budget past 100% needs a
human, however small. A $200 order against a budget with $50 left is an
overspend.

`approval-chain.md` — an agent may prepare and submit a request for approval. It
may not *be* the approval. Covers acting on an approver's behalf, and splitting
a request to duck a more senior approver.

---

## Status

Built and tested against a mock Zip API: 9 tests covering budget arithmetic,
argument extraction, the assembled context, and degradation when an endpoint
fails. **Not yet run against the real Zip API** — that needs the company and
token they provide.

Remote MCP proxying is implemented and typechecks; it has been exercised against
stdio upstreams but not yet against a live remote MCP server.
