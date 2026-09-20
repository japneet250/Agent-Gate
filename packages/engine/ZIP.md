# Zip integration

Zip runs the purchasing workflow: budgets, approval limits, vendors, policy, and
the people who sign off. AgentGate governs what an agent is allowed to *do*
inside it.

Two integrations, at different layers.

---

## 1. AgentGate in front of Zip's MCP server

Zip publishes a **remote** MCP server. AgentGate is an MCP proxy, so it sits
between the agent and Zip:

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
export AGENTGATE_UPSTREAM_TOKEN="$ZIP_MCP_TOKEN"
npm run mcp -w packages/gateway -- https://<zip-mcp-host>/mcp
# older servers: AGENTGATE_UPSTREAM_TRANSPORT=sse
```

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

| variable | default | |
| --- | --- | --- |
| `ZIP_API_TOKEN` | — | required; empty disables grounding entirely |
| `ZIP_API_BASE` | `https://api.ziphq.com/v1` | |
| `ZIP_BUDGETS_PATH` | `/budgets` | |
| `ZIP_VENDORS_PATH` | `/vendors` | |
| `ZIP_APPROVALS_PATH` | `/approval-chains` | |

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
