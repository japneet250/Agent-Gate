"""Query enrichment for retrieval.

A raw payload shares no vocabulary with policy prose: "123-45-6789" has no token
in common with "personally identifiable information". Naming the entity types we
can detect gives both the dense and sparse retrievers something to match on, so
the right policy surfaces for the payload that actually violates it.

This is a retrieval aid only. It makes no decision and blocks nothing.
"""

from __future__ import annotations

import re

_DETECTORS: list[tuple[str, re.Pattern[str]]] = [
    (
        "social security number SSN personally identifiable information",
        re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    ),
    (
        "credit card payment card number personally identifiable information",
        re.compile(r"\b(?:\d[ -]?){13,16}\b"),
    ),
    (
        "date of birth personally identifiable information",
        re.compile(r"\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\bdob\b|\bdate of birth\b|\bborn\b", re.I),
    ),
    ("email address contact detail", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")),
    (
        "home address personally identifiable information",
        re.compile(r"\b\d+\s+[A-Za-z]+\s+(street|st|road|rd|avenue|ave|drive|dr|lane|ln)\b", re.I),
    ),
    (
        "API key secret credential token password",
        re.compile(r"\b(api[_-]?key|secret|password|token|bearer|sk-[a-z0-9-]{8,})\b", re.I),
    ),
    (
        "destructive SQL statement schema change",
        re.compile(r"\b(drop\s+table|truncate|alter\s+table|delete\s+from|update\s+\w+\s+set)\b", re.I),
    ),
    (
        "destructive shell command file deletion",
        re.compile(r"(rm\s+-rf|mkfs|dd\s+if=|chmod\s+777|curl[^|]*\|\s*(ba)?sh)", re.I),
    ),
    (
        "bulk export of many records",
        re.compile(r"\b(limit\s*[:=]?\s*\d{3,}|select\s+\*|export|dump|all\s+records)\b", re.I),
    ),
    (
        "privilege escalation permission grant admin role",
        re.compile(r"\b(grant|admin|superuser|sudo|root|iam|privilege|role)\b", re.I),
    ),
    ("money payment amount transaction", re.compile(r"\b(amount|total|price|cost|usd|\$\s?\d)", re.I)),
    (
        "instruction injection embedded in data",
        re.compile(
            r"\b(ignore (all )?(previous|prior) instructions?|disregard the above|you must (now )?(set|approve))\b",
            re.I,
        ),
    ),
]


def detect_entities(payload: str) -> list[str]:
    """Exposed for tests and for the dashboard's "why was this retrieved" view."""
    return [label for label, pattern in _DETECTORS if pattern.search(payload)]


def enrich_query(base_query: str, payload: str) -> str:
    """Append descriptions of whatever sensitive shapes appear in the action."""
    found = detect_entities(payload)
    if not found:
        return base_query
    return f"{base_query}\nDetected in the payload: {'; '.join(found)}."
