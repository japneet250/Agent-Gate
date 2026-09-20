# CSE Log & Order — traffic through AgentGate's lens

A network connection is an action an actor took. AgentGate already decides
whether an action should have been allowed. So the detection system **is**
AgentGate — the same policies, the same cumulative detector, the same judge.

```
agent           →  the source host that opened the connection
session         →  that host's activity window
tool call       →  the connection
tool arguments  →  destination, port, protocol, bytes, duration
cumulative      →  bytes a host has sent out, connections it has opened
```

"Thirty $400 purchases totalling $12,000" and "six hundred small uploads
totalling 1.2GB to one host" are the same detection with a different
`Accumulate:` expression in a policy file.

## Run it

```bash
python -m agentgate_engine.cse conn.log --json report.json
```

Reads Zeek `conn.log`, CSV, or JSON lines — sniffed, not assumed. Column names
are aliased across the common spellings (`id.orig_h`, `src_ip`, `source_ip`,
`srcaddr`…), and any column it does not recognise is kept rather than dropped.
Throwing away an unknown field is how a forensic tool loses the one thing that
mattered.

## Why it is affordable

A capture has hundreds of thousands of connections. The judge costs ~2s and real
money per call, so judging everything is neither affordable nor useful — almost
all of it is a laptop fetching a web page. Same answer as the product: triage
first, reason second.

| tier | what | cost |
| --- | --- | --- |
| 1 | every connection: port, direction, volume, upload ratio, beaconing regularity | free |
| 2 | the LLM judge, on what tier 1 could not dismiss, worst first | ~2s each |
| 3 | cumulative limits across each host's whole session | free |

Measured on a 3,792-connection capture: **8 groups judged, 0.2% of traffic.**

## What tier 1 looks for

**Beaconing.** A human browses irregularly; malware checks in on a timer. The
coefficient of variation across inter-arrival gaps below 0.15 over six or more
connections is the signal. In testing, 180 connections at exact 60s intervals
scored 0% variation; twenty randomly-spaced human requests scored nothing.

**Volume and ratio.** Bytes out, and out-to-in ratio. A host that sent 1.2GB
with a 3026:1 upload ratio is not browsing.

**Destination.** Ports associated with C2, backdoors and unmonitored chat.

**Inbound remote access.** SSH or RDP arriving from outside the network.

## Verified against a capture with known ground truth

3,792 connections, three planted incidents, none of them labelled:

```
[BLOCK] risk 100   10.0.1.37 -> 203.0.113.66    connect_unusual_port
    180 connections · port 4444 · regular 60s interval (variation 0%) — beaconing

[BLOCK] risk 100   10.0.1.44 -> 198.51.100.23   1,198,264,623 bytes out
    600 connections · upload/download ratio 3026:1

[BLOCK] risk  70   45.83.x   -> 10.0.1.8        remote_desktop
    inbound remote access from an external address
```

All three found. It also parsed a malformed three-octet address without
crashing, which a real dataset will contain.

## The report

Who, what, when, how — because a finding nobody can act on is not a finding.
`--json` writes the same thing machine-readable, with per-host totals.

## Policies

Network detection is policy, not code, like everything else:

- `network-exfiltration.md` — cumulative outbound volume per host, declared as
  `Accumulate: sum(toolArgs.bytesOut)` with a 500MB session limit
- `network-unusual-ports.md` — C2 and backdoor ports; a connection carrying
  almost no bytes is not evidence of innocence, because beaconing is designed
  to look small
- `network-remote-access.md` — inbound shell and desktop access

An analyst adds their own through `POST /policies` without touching code.

## Status

Built and verified against a synthetic capture with known ground truth. **Not
yet run against CSE's real dataset** — the loader handles the three formats it
is likely to arrive in, and unknown columns survive, but expect to add column
aliases on first contact.
