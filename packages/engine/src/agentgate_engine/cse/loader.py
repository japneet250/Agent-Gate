"""Reading traffic logs.

A dataset arrives in whatever format the provider used, so the loader sniffs
rather than assuming: Zeek `conn.log` (TSV with #fields header), plain CSV with
a header row, or JSON lines. Unknown columns are kept in `extra` — throwing away
a field because this parser did not recognise it is how a forensic tool loses
the one thing that mattered.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

# Column names the same concept appears under across common formats.
_ALIASES = {
    "ts": ("ts", "timestamp", "time", "start_time", "starttime", "date", "@timestamp"),
    "src_ip": ("id.orig_h", "src_ip", "source_ip", "src", "source", "srcaddr", "client_ip"),
    "src_port": ("id.orig_p", "src_port", "source_port", "sport", "srcport"),
    "dst_ip": ("id.resp_h", "dst_ip", "dest_ip", "destination_ip", "dst", "dstaddr", "server_ip"),
    "dst_port": ("id.resp_p", "dst_port", "dest_port", "dport", "dstport"),
    "proto": ("proto", "protocol", "transport", "service"),
    "bytes_out": ("orig_bytes", "bytes_out", "sent_bytes", "src_bytes", "out_bytes", "bytes_sent"),
    "bytes_in": ("resp_bytes", "bytes_in", "recv_bytes", "dst_bytes", "in_bytes", "bytes_received"),
    "duration": ("duration", "elapsed", "dur"),
    "state": ("conn_state", "state", "status", "action"),
    "host": ("host", "hostname", "query", "uri", "url", "domain", "server_name"),
}


@dataclass
class Connection:
    """One connection, normalised."""

    ts: datetime
    src_ip: str
    dst_ip: str
    dst_port: int = 0
    src_port: int = 0
    proto: str = ""
    bytes_out: int = 0
    bytes_in: int = 0
    duration: float = 0.0
    state: str = ""
    host: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def uid(self) -> str:
        return f"{self.src_ip}:{self.src_port}->{self.dst_ip}:{self.dst_port}"


def sniff_format(sample: str) -> str:
    head = sample.lstrip()
    if head.startswith("#separator") or "#fields" in sample[:2000]:
        return "zeek"
    if head.startswith("{"):
        return "jsonl"
    return "csv"


def _num(value: Any, cast=int) -> Any:
    if value in (None, "", "-", "(empty)"):
        return cast(0)
    try:
        return cast(float(value))
    except (TypeError, ValueError):
        return cast(0)


def _timestamp(raw: Any) -> datetime:
    if raw in (None, "", "-"):
        return datetime.now(timezone.utc)
    try:  # epoch seconds, which is what Zeek writes
        return datetime.fromtimestamp(float(raw), tz=timezone.utc)
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(str(raw).replace("Z", "+0000"), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime.now(timezone.utc)


def _pick(row: dict[str, Any], key: str) -> Any:
    lowered = {k.lower(): v for k, v in row.items()}
    for alias in _ALIASES[key]:
        if alias in lowered:
            return lowered[alias]
    return None


def _to_connection(row: dict[str, Any]) -> Connection | None:
    src, dst = _pick(row, "src_ip"), _pick(row, "dst_ip")
    if not src or not dst:
        return None  # not a connection record

    known = {a for aliases in _ALIASES.values() for a in aliases}
    return Connection(
        ts=_timestamp(_pick(row, "ts")),
        src_ip=str(src),
        dst_ip=str(dst),
        src_port=_num(_pick(row, "src_port")),
        dst_port=_num(_pick(row, "dst_port")),
        proto=str(_pick(row, "proto") or ""),
        bytes_out=_num(_pick(row, "bytes_out")),
        bytes_in=_num(_pick(row, "bytes_in")),
        duration=_num(_pick(row, "duration"), float),
        state=str(_pick(row, "state") or ""),
        host=str(_pick(row, "host") or ""),
        # Anything this parser did not recognise is kept, not dropped.
        extra={k: v for k, v in row.items() if k.lower() not in known and v not in ("", "-")},
    )


def _zeek_rows(text: str) -> Iterator[dict[str, Any]]:
    fields: list[str] = []
    for line in text.splitlines():
        if line.startswith("#fields"):
            fields = line.split("\t")[1:]
            continue
        if line.startswith("#") or not line.strip():
            continue
        if not fields:
            continue
        yield dict(zip(fields, line.split("\t")))


def load_connections(path: str | Path, limit: int | None = None) -> list[Connection]:
    """Parse a traffic log into normalised connections."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    fmt = sniff_format(text)

    if fmt == "zeek":
        rows: Iterator[dict[str, Any]] = _zeek_rows(text)
    elif fmt == "jsonl":
        rows = (json.loads(l) for l in text.splitlines() if l.strip())
    else:
        rows = iter(csv.DictReader(io.StringIO(text)))

    out: list[Connection] = []
    for row in rows:
        conn = _to_connection(row)
        if conn is not None:
            out.append(conn)
        if limit and len(out) >= limit:
            break
    return out
