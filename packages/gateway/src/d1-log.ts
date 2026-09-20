/**
 * The action log, in Cloudflare D1, over the REST API.
 *
 * D1 bindings only exist inside the Worker runtime, so a gateway run on a
 * laptop — which is how the MCP proxy and the whole demo run — had nowhere
 * durable to put its decisions. The in-memory ring covered that, but it dies
 * with the process: restart the gateway and the audit trail is gone.
 *
 * A firewall whose record of what it refused does not survive a restart is not
 * an audit log. This writes the same rows the Worker writes, to the same table,
 * from anywhere.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and D1_DATABASE_ID. Without
 * them the gateway keeps working off the ring alone and says so at startup,
 * because silently losing the audit trail is exactly the failure worth being
 * loud about.
 */
import type { ActionLogRow } from './handler.js';
import { log } from './log.js';

const COLUMNS = [
  'id', 'action_id', 'created_at', 'agent_id', 'session_id', 'tool_name',
  'arg_keys', 'tool_args', 'decision', 'risk_score', 'reasoning',
  'violated_policy', 'latency_ms', 'category', 'degraded', 'decided_by',
  'retrieved_policies', 'pattern_notes',
] as const;

// Added by migration 0003. Kept apart so a database that has not had it applied yet still logs.
const ZIP_COLUMN = 'zip_facts';

export type D1Config = { accountId: string; apiToken: string; databaseId: string };

export function d1ConfigFromEnv(env = process.env): D1Config | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const databaseId = env.D1_DATABASE_ID;
  if (!accountId || !apiToken || !databaseId) return undefined;
  return { accountId, apiToken, databaseId };
}

export class D1ActionLog {
  constructor(private readonly cfg: D1Config) {}

  private async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.cfg.accountId}/d1/database/${this.cfg.databaseId}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await res.json()) as {
      success?: boolean;
      errors?: { message: string }[];
      result?: { results?: Record<string, unknown>[] }[];
    };
    if (!res.ok || !body.success) {
      throw new Error(body.errors?.map((e) => e.message).join('; ') ?? `D1 returned ${res.status}`);
    }
    return body.result?.[0]?.results ?? [];
  }

  /** Write one decided action. */
  async write(row: ActionLogRow): Promise<void> {
    // `id` is generated here rather than taken from the caller: action_id is
    // not unique (a retried action keeps its id) and a caller must not be able
    // to overwrite or suppress an existing audit row by reusing one.
    const id = crypto.randomUUID();
    const argKeys = row.tool_args ?? '[]';
    const base = [
      id, row.action_id, row.created_at, row.agent_id, row.session_id, row.tool_name,
      argKeys, row.tool_args ?? null, row.decision, row.risk_score, row.reasoning,
      row.violated_policy ?? null, row.latency_ms, row.category ?? null,
      row.degraded ?? 0, row.decided_by ?? 'rules',
      row.retrieved_policies ?? null, row.pattern_notes ?? null,
    ];
    const insert = (cols: readonly string[], vals: unknown[]) =>
      this.query(`INSERT INTO action_logs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
    try {
      await insert([...COLUMNS, ZIP_COLUMN], [...base, row.zip_facts ?? null]);
    } catch (err) {
      // Migration 0003 not applied yet: log without the Zip facts rather than lose the audit row.
      if (!String((err as Error).message).includes(ZIP_COLUMN)) throw err;
      await insert(COLUMNS, base);
    }
  }

  /** Rows decided after `sinceMs`, oldest first — the same contract the ring has. */
  async since(sinceMs: number, limit = 500): Promise<ActionLogRow[]> {
    const rows = sinceMs
      ? await this.query(
          `SELECT * FROM action_logs WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`,
          [new Date(sinceMs).toISOString(), limit],
        )
      : // Newest N, then flipped: on a cold start the feed should show the most
        // recent history, not the oldest rows in the table.
        (
          await this.query(`SELECT * FROM action_logs ORDER BY created_at DESC LIMIT ?`, [limit])
        ).reverse();
    return rows as unknown as ActionLogRow[];
  }

  /** Cheap liveness check so a broken config is found at startup, not mid-demo. */
  async reachable(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (err) {
      log('D1 action log unreachable:', (err as Error).message);
      return false;
    }
  }
}
