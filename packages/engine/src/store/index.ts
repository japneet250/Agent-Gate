import { MemorySessionStore, MemoryVectorStore } from './memory.ts';
import type { SessionStore, VectorStore } from './types.ts';

/**
 * Swap point for Cloudflare. At the gateway's boot, call
 * `configureStores({ vectors: new VectorizeStore(env.POLICY_INDEX), sessions: new D1SessionStore(env.DB) })`
 * and nothing else in the engine changes.
 */
let vectors: VectorStore = new MemoryVectorStore();
let sessions: SessionStore = new MemorySessionStore();

export function configureStores(next: { vectors?: VectorStore; sessions?: SessionStore }): void {
  if (next.vectors) vectors = next.vectors;
  if (next.sessions) sessions = next.sessions;
}

export const vectorStore = (): VectorStore => vectors;
export const sessionStore = (): SessionStore => sessions;

export * from './types.ts';
export { MemorySessionStore, MemoryVectorStore, cosine } from './memory.ts';
