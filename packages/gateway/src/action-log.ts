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

const DEFAULT_CAPACITY = 500;

export class ActionLog {
  private rows: ActionLogRow[] = [];

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  record(action: AgentAction, result: Verdict): void {
    const extra = result as Partial<{
      category: string; degraded: boolean;
      retrievedPolicies: unknown[]; patternNotes: unknown[]; decidedBy: string;
    }>;
    this.rows.push({
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
    });
    if (this.rows.length > this.capacity) this.rows.splice(0, this.rows.length - this.capacity);
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
