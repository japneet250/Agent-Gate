import type { AgentAction } from '@agentgate/shared';
import type { Verdict } from './evaluate.js';
import { reportError } from './monitoring.js';
import { redactArgs } from './redact.js';

// Minimal shape of a Cloudflare D1 binding (just what we use), so we don't need the Workers type package.
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  };
}

/**
 * Remembers which policies are switched off in the `policies` table. Reads are cached for `ttlMs`, so
 * dashboard toggles take effect within that time. On a read failure it keeps the last known state:
 * on a cold start that means every rule stays ON (the safe default).
 */
export function createPolicyCache(db: D1Like | undefined, ttlMs = 15_000, now: () => number = Date.now) {
  let disabled = new Set<string>();
  let fetchedAt = -Infinity;
  return {
    isEnabled: (policyId: string) => !disabled.has(policyId),
    async refresh(): Promise<void> {
      if (!db || now() - fetchedAt < ttlMs) return;
      fetchedAt = now(); // set first so a failing database is retried every ttl, not on every request
      try {
        const { results } = await db.prepare('SELECT id FROM policies WHERE enabled = 0').all<{ id: string }>();
        disabled = new Set(results.map((r) => r.id));
      } catch (err) {
        console.error('[agentgate] could not read policies, keeping last known state:', err);
        reportError(err, 'policies-read');
      }
    },
  };
}

const json = (v: unknown[] | undefined) => (v === undefined ? null : JSON.stringify(v).slice(0, 4000));

/** Writes one row to `action_logs`. Tool arguments are stored redacted (see redact.ts), never raw. */
export async function insertActionLog(db: D1Like, action: AgentAction, result: Verdict): Promise<void> {
  await db
    .prepare(
      `INSERT INTO action_logs
         (id, action_id, created_at, agent_id, session_id, tool_name, arg_keys, tool_args, decision, risk_score, reasoning,
          violated_policy, latency_ms, category, degraded, decided_by, retrieved_policies, pattern_notes, guardrails)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      action.id,
      action.timestamp.toISOString(),
      action.agentId,
      action.sessionId,
      action.toolName,
      JSON.stringify(Object.keys(action.toolArgs)),
      redactArgs(action.toolArgs),
      result.decision,
      result.riskScore,
      result.reasoning,
      result.violatedPolicy ?? null,
      result.latencyMs,
      result.category ?? null,
      result.degraded ? 1 : 0,
      result.decidedBy ?? 'rules',
      json(result.retrievedPolicies),
      json(result.patternNotes),
      json(result.guardrails),
    )
    .run();
}
