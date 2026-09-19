import {
  emptySession,
  type SessionState,
  type SessionStore,
  type VectorMatch,
  type VectorRecord,
  type VectorStore,
} from './types.ts';

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Exhaustive cosine scan. Fine for ~20 policies; swap for Vectorize at scale. */
export class MemoryVectorStore implements VectorStore {
  private records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const r of records) this.records.set(r.id, r);
  }

  async query(vector: number[], topK: number): Promise<VectorMatch[]> {
    return [...this.records.values()]
      .map((r) => ({ id: r.id, score: cosine(vector, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async size(): Promise<number> {
    return this.records.size;
  }
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionState>();

  async get(sessionId: string): Promise<SessionState> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = emptySession(sessionId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  async save(state: SessionState): Promise<void> {
    this.sessions.set(state.sessionId, state);
  }

  async reset(): Promise<void> {
    this.sessions.clear();
  }
}
