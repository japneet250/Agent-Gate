"""CSE Log & Order — network traffic through AgentGate's lens.

The claim is simple: a network connection is an action an actor took, and
AgentGate already decides whether an action should have been allowed. Treat each
connection as an agent action and the whole pipeline applies unchanged —
policies, the cumulative detector, the judge, the guardrails.

The mapping that makes it work:

    agent           ->  the source host that opened the connection
    session         ->  that host's activity window
    tool call       ->  the connection itself
    tool arguments  ->  destination, port, protocol, bytes, duration
    cumulative      ->  bytes a host has sent out, connections it has opened

So "thirty $400 purchases that total $12,000" and "four thousand small uploads
that total 2GB to one host" are the same detection, with a different
`Accumulate:` expression in a policy file.
"""

from .loader import Connection, load_connections, sniff_format
from .mapper import connection_to_action
from .report import ForensicReport, analyse

__all__ = [
    "Connection",
    "load_connections",
    "sniff_format",
    "connection_to_action",
    "ForensicReport",
    "analyse",
]
