"""Okapi BM25 over the policy corpus.

Replaces a naive |query ∩ doc| / |query| overlap. That overlap had no notion of
term rarity, so "data" counted as much as "ssn", and no length normalisation, so
a long policy scored well simply for containing more words.

Measured honestly: on the current 21-policy corpus, plus 16 deliberately
topically-adjacent distractors, BM25 and the naive overlap both retrieve the
right policy in the top 5 every time. BM25 is not here because it beat the
overlap today — it is here because it is the correct algorithm and it degrades
gracefully as a customer's corpus grows past the point where any bag-of-words
metric with no IDF stops discriminating.

Index rebuilds are O(corpus) and happen when policies change, not per query.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "be", "may",
    "not", "that", "this", "with", "as", "by", "from", "it", "its", "any", "all", "must",
    "agent", "agents", "action", "called", "arguments", "tool", "category",
}

# Okapi defaults. k1 controls how fast term frequency saturates; b how strongly
# document length is normalised.
K1 = 1.5
B = 0.75


def tokenize(text: str) -> list[str]:
    """Token list, not a set: BM25 needs term frequency."""
    return [
        t for t in re.split(r"[^a-z0-9$]+", text.lower()) if len(t) > 2 and t not in _STOP
    ]


@dataclass
class BM25Index:
    """An inverted index over the policy corpus."""

    doc_len: dict[str, int] = field(default_factory=dict)
    tf: dict[str, dict[str, int]] = field(default_factory=dict)   # doc_id -> term -> count
    df: dict[str, int] = field(default_factory=dict)              # term -> docs containing it
    avgdl: float = 0.0

    @property
    def size(self) -> int:
        return len(self.doc_len)

    def build(self, documents: dict[str, str]) -> "BM25Index":
        self.doc_len.clear()
        self.tf.clear()
        self.df.clear()
        for doc_id, text in documents.items():
            terms = tokenize(text)
            counts: dict[str, int] = {}
            for t in terms:
                counts[t] = counts.get(t, 0) + 1
            self.tf[doc_id] = counts
            self.doc_len[doc_id] = len(terms)
            for t in counts:
                self.df[t] = self.df.get(t, 0) + 1
        self.avgdl = (sum(self.doc_len.values()) / self.size) if self.size else 0.0
        return self

    def _idf(self, term: str) -> float:
        # Lucene's variant: always positive, so a term in every document
        # contributes ~0 rather than going negative.
        n = self.df.get(term, 0)
        return math.log(1 + (self.size - n + 0.5) / (n + 0.5))

    def score(self, query: str, doc_id: str) -> float:
        counts = self.tf.get(doc_id)
        if not counts or not self.size:
            return 0.0
        dl = self.doc_len[doc_id] or 1
        total = 0.0
        for term in tokenize(query):
            f = counts.get(term)
            if not f:
                continue
            total += self._idf(term) * (f * (K1 + 1)) / (
                f + K1 * (1 - B + B * dl / self.avgdl)
            )
        return total

    def score_all(self, query: str) -> dict[str, float]:
        """Raw BM25 per document.

        Scores are unbounded, so callers that blend them with cosine similarity
        must normalise first — see `normalised` below.
        """
        return {doc_id: self.score(query, doc_id) for doc_id in self.tf}

    def normalised(self, query: str) -> dict[str, float]:
        """BM25 scaled to 0-1 by the best score for this query.

        Needed because the hybrid blend mixes this with cosine similarity, which
        is already bounded. Without scaling, one query's BM25 of 12 and another's
        of 3 would weight the sparse signal completely differently.
        """
        raw = self.score_all(query)
        top = max(raw.values(), default=0.0)
        if top <= 0:
            return {k: 0.0 for k in raw}
        return {k: v / top for k, v in raw.items()}
