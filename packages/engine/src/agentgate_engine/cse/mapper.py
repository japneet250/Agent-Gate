"""Turning a connection into an action the engine can judge.

The mapping matters more than it looks. The engine reasons about *what an actor
did*, so a connection has to arrive as an intent, not as a row of numbers. A
tool name of "connection" tells the judge nothing; `dns_query`, `file_upload`
and `remote_shell` each carry meaning it can weigh against a policy.

Port and volume are how you infer that intent from a conn log, and the inference
is stated here rather than hidden in a prompt.
"""

from __future__ import annotations

import ipaddress
from typing import Any

from agentgate_shared import AgentAction

from .loader import Connection

# Well-known ports, named by what an actor is doing rather than by the service.
_PORT_INTENT = {
    22: "remote_shell", 23: "remote_shell_insecure", 25: "send_email",
    53: "dns_query", 80: "web_request", 110: "fetch_email", 143: "fetch_email",
    389: "directory_query", 443: "web_request_encrypted", 445: "file_share_access",
    587: "send_email", 1433: "database_query", 3306: "database_query",
    3389: "remote_desktop", 5432: "database_query", 5900: "remote_desktop",
    6379: "cache_access", 8080: "web_request", 9200: "search_index_query",
    27017: "database_query",
}

# Ports that are not a service so much as a signal.
_SUSPICIOUS_PORTS = {4444: "known_c2_port", 31337: "known_backdoor_port",
                     6667: "irc_channel", 1337: "known_backdoor_port"}


# What counts as "inside the network". Deliberately NOT ipaddress.is_private,
# which also returns True for the documentation ranges (192.0.2.0/24,
# 198.51.100.0/24, 203.0.113.0/24). Those stand in for PUBLIC addresses in every
# example dataset, so treating them as internal would silently classify the
# exfiltration in a sample capture as internal traffic and hide it.
_INTERNAL_NETS = tuple(
    ipaddress.ip_network(n)
    for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
              "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10",
              "fc00::/7", "::1/128", "fe80::/10")
)


def _is_internal(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in _INTERNAL_NETS)


def infer_tool(conn: Connection) -> str:
    """What the connection amounts to, as a tool name the judge can reason about."""
    if conn.dst_port in _SUSPICIOUS_PORTS:
        return "connect_unusual_port"
    intent = _PORT_INTENT.get(conn.dst_port)
    if intent:
        # A "web request" that uploads 50MB is an upload, whatever the port says.
        if intent.startswith("web_request") and conn.bytes_out > 5_000_000:
            return "file_upload"
        return intent
    if conn.bytes_out > 1_000_000 and conn.bytes_out > conn.bytes_in * 10:
        return "file_upload"
    return "network_connection"


def connection_to_action(conn: Connection, *, session_id: str | None = None) -> AgentAction:
    """One connection as an AgentAction.

    The source host becomes the agent: cumulative limits are per-session, and a
    host's own traffic is the window that matters for spotting exfiltration.
    """
    internal_src = _is_internal(conn.src_ip)
    internal_dst = _is_internal(conn.dst_ip)

    args: dict[str, Any] = {
        "destination": conn.host or conn.dst_ip,
        "destinationIp": conn.dst_ip,
        "port": conn.dst_port,
        "protocol": conn.proto or "tcp",
        "bytesOut": conn.bytes_out,
        "bytesIn": conn.bytes_in,
        "durationSeconds": round(conn.duration, 2),
        "direction": "outbound" if internal_src and not internal_dst else
                     "inbound" if internal_dst and not internal_src else "internal",
    }
    if conn.dst_port in _SUSPICIOUS_PORTS:
        args["portNote"] = _SUSPICIOUS_PORTS[conn.dst_port]
    if conn.state:
        args["connectionState"] = conn.state
    args.update(conn.extra)

    return AgentAction(
        id=conn.uid,
        agentId=conn.src_ip,
        toolName=infer_tool(conn),
        toolArgs=args,
        timestamp=conn.ts,
        # Per-host session, so cumulative limits accumulate over that host's
        # traffic rather than over the whole capture.
        sessionId=session_id or f"host:{conn.src_ip}",
    )
