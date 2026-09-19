/**
 * Storage seams. The engine only ever talks to these interfaces, so moving to
 * Cloudflare (Vectorize for vectors, D1 / Durable Objects for session state) is
 * a new implementation of one interface, not a change to the pipeline.
 */

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  query(vector: number[], topK: number): Promise<VectorMatch[]>;
  size(): Promise<number>;
}

/** Per-session counters the Pattern Detector accumulates across actions. */
export interface SessionState {
  sessionId: string;
  totalSpend: number;
  actionCounts: Record<string, number>;
  dataAccessCount: number;
  permissionRequests: number;
  lastActions: { toolName: string; argsKey: string; at: number }[];
  /** Trimmed recent actions, so the judge sees session history even when the
   *  caller does not pass any. Newest last. */
  recentActions: { toolName: string; toolArgs: Record<string, unknown>; at: number }[];
  /** Fingerprint -> risk score, used by the consistency guardrail. */
  scoreHistory: { fingerprint: string; riskScore: number }[];
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionState>;
  save(state: SessionState): Promise<void>;
  reset(): Promise<void>;
}

export function emptySession(sessionId: string): SessionState {
  return {
    sessionId,
    totalSpend: 0,
    actionCounts: {},
    dataAccessCount: 0,
    permissionRequests: 0,
    lastActions: [],
    recentActions: [],
    scoreHistory: [],
  };
}
