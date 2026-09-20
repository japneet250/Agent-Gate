import type { AgentAction } from '@agentgate/shared';
import type { Verdict } from './evaluate.js';
import { reportError } from './monitoring.js';
import { redactArgs } from './redact.js';
import { maskPii } from './rules.js';

// Minimal shape of a Cloudflare D1 binding (just what we use), so we don't need the Workers type package.
export interface D1Like {
  prepare(sql: string): {
    // Real D1 allows all() after bind() as well as run(); the type only
    // declared run(), so a bound SELECT did not typecheck.
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
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
const ACTION_COLUMNS =
  'action_id, created_at, agent_id, session_id, tool_name, tool_args, decision, ' +
  'risk_score, reasoning, violated_policy, latency_ms, category, degraded, ' +
  'decided_by, retrieved_policies, pattern_notes, zip_facts';

/**
 * The decision feed, newest last so a poller can page forward by timestamp.
 *
 * Capped because a dashboard asking for everything since epoch on a busy
 * gateway would pull the whole table into a browser.
 */
export async function recentActionLogs(
  db: D1Like,
  sinceMs = 0,
  limit = 200,
): Promise<Record<string, unknown>[]> {
  const since = sinceMs ? new Date(sinceMs).toISOString() : '1970-01-01T00:00:00.000Z';
  const { results } = await db
    .prepare(
      `SELECT ${ACTION_COLUMNS} FROM action_logs WHERE created_at > ?1 ` +
        `ORDER BY created_at ASC LIMIT ?2`,
    )
    .bind(since, limit)
    .all();
  return (results ?? []) as Record<string, unknown>[];
}

export async function insertActionLog(db: D1Like, action: AgentAction, result: Verdict): Promise<void> {
  await db
    .prepare(
      `INSERT INTO action_logs
         (id, action_id, created_at, agent_id, session_id, tool_name, arg_keys, tool_args, decision, risk_score, reasoning,
          violated_policy, latency_ms, category, degraded, decided_by, retrieved_policies, pattern_notes, guardrails, zip_facts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // Vendor and budget names, not arguments, but mask PII on the way in anyway: this table is what a screen shows.
      json(result.zipFacts?.map(maskPii)),
    )
    .run();
}
