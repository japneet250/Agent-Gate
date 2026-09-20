/**
 * An in-memory ring of decided actions.
 *
 * D1 only exists inside the Worker runtime, so a gateway run locally — which is
 * how the MCP proxy and the demo run — has nowhere to put its decisions and the
 * dashboard's live feed has nothing to read. This is that store: bounded, in
 * process, lost on restart, and enough to drive a demo without deploying.
 *
 * It is deliberately NOT a replacement for D1. Nothing here survives a restart
 * and nothing is shared between processes; the Worker still writes the durable
 * copy.
 */
import type { AgentAction } from '@agentgate/shared';
import type { ActionLogRow } from './handler.js';
import type { Verdict } from './evaluate.js';
import { describeArgs } from './log.js';
import { maskPii } from './rules.js';

const DEFAULT_CAPACITY = 500;

export class ActionLog {
  private rows: ActionLogRow[] = [];

  /**
   * `sink`, when present, receives every row this log records — see
   * `sinkFromEnv`. A collector gateway has no sink; the gateways spawned by
   * agents forward to it.
   */
  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly sink?: (row: ActionLogRow) => Promise<void>,
  ) {}

  /**
   * Sink writes in flight. A gateway spawned by an agent exits as soon as the
   * agent disconnects, and an unawaited fetch dies with the process — which is
   * exactly how the first version of this silently forwarded nothing.
   */
  private pending = new Set<Promise<void>>();

  /** Wait for forwarded rows to land. Call before exiting. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Accept a row decided by another gateway process. */
  ingest(row: ActionLogRow): void {
    this.rows.push(row);
    this.trim();
  }

  private trim(): void {
    if (this.rows.length > this.capacity) this.rows.splice(0, this.rows.length - this.capacity);
  }

  record(action: AgentAction, result: Verdict): void {
    const extra = result as Partial<{
      category: string; degraded: boolean;
      retrievedPolicies: unknown[]; patternNotes: unknown[]; decidedBy: string; zipFacts: string[];
    }>;
    const row: ActionLogRow = {
      action_id: action.id,
      created_at: new Date().toISOString(),
      agent_id: action.agentId,
      session_id: action.sessionId,
      tool_name: action.toolName,
      // Argument NAMES only, never values: a blocked call's arguments are the
      // SSN or the card number that got it blocked, and a feed on a screen at a
      // conference is the last place they should be.
      tool_args: JSON.stringify(describeArgs(action.toolArgs)),
      decision: result.decision,
      risk_score: result.riskScore,
      reasoning: result.reasoning,
      violated_policy: result.violatedPolicy ?? null,
      latency_ms: result.latencyMs,
      category: extra.category ?? null,
      degraded: extra.degraded ? 1 : 0,
      decided_by: extra.decidedBy ?? (result.latencyMs < 50 ? 'rules' : 'judge'),
      retrieved_policies: extra.retrievedPolicies ? JSON.stringify(extra.retrievedPolicies) : null,
      pattern_notes: extra.patternNotes ? JSON.stringify(extra.patternNotes) : null,
      zip_facts: extra.zipFacts ? JSON.stringify(extra.zipFacts.map(maskPii)) : null,
    };
    this.rows.push(row);
    this.trim();
    if (this.sink) {
      const p = this.sink(row).finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  /** Rows decided after `sinceMs`, oldest first, so a poller can page forward. */
  since(sinceMs: number): ActionLogRow[] {
    if (!sinceMs) return [...this.rows];
    return this.rows.filter((r) => Date.parse(r.created_at) > sinceMs);
  }

  get size(): number {
    return this.rows.length;
  }
}

/**
 * Forwards decided rows to another gateway's POST /ingest.
 *
 * The demo bots and Claude Desktop each spawn their OWN gateway process, and an
 * ActionLog is per-process and in memory. Without this, an agent's blocks land
 * in a ring nobody reads: the left screen shows the refusal and the right screen
 * shows nothing, which is the entire two-screen demo failing quietly.
 *
 * Set AGENTGATE_ACTION_SINK to the collector's /ingest URL. Spawned gateways
 * inherit it from the environment, so one export wires every process.
 *
 * Fire-and-forget on purpose: a firewall must not get slower, or fail a tool
 * call, because a dashboard is down.
 */
export function sinkFromEnv(env = process.env): ((row: ActionLogRow) => Promise<void>) | undefined {
  const url = env.AGENTGATE_ACTION_SINK;
  if (!url) return undefined;
  return async (row) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(row),
      });
    } catch {
      // Deliberately silent. A dead collector is a missing feed row, never a
      // blocked agent and never a stack trace in the middle of a demo.
    }
  };
}
