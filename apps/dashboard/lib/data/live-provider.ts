import type {
  BenchmarkMetrics,
  DataProvider,
  DemoMoment,
  EvaluatedAction,
  Policy,
} from './types';

/**
 * Live backend adapter.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT STATUS, as measured against the integration branch (not assumed):
 *
 *   EXISTS  POST {gateway}/evaluate   -> { riskScore, decision, reasoning,
 *                                          violatedPolicy?, latencyMs }
 *           GET  {gateway}/health     -> { ok: true }
 *           GET  {engine}/policies    -> 21 policies (name, description,
 *                                          severity, appliesTo, enforcedBy)
 *           GET  {engine}/health      -> config + running decision counts
 *           GET  {engine}/sessions/:id-> live cumulative spend / action counts
 *
 *   MISSING GET  {gateway}/actions    -> the action feed.
 *           P1 writes every decision to D1 `action_logs` with exactly the
 *           columns this dashboard renders (action_id, created_at, agent_id,
 *           session_id, tool_name, tool_args redacted, decision, risk_score,
 *           reasoning, violated_policy, latency_ms, category, degraded,
 *           decided_by, retrieved_policies, pattern_notes, guardrails) — but
 *           there is no HTTP route to read them back yet.
 *
 *           Until that route exists, live mode renders an explicit
 *           "feed unavailable" state. It does NOT silently fall back to mock
 *           data: a demo that looks live while replaying fixtures is the one
 *           failure mode worth engineering against.
 * ---------------------------------------------------------------------------
 */

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8787';
const ENGINE = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:8000';

/** The D1 `action_logs` row shape, as P1 writes it. Renaming this to
 *  EvaluatedAction is the whole of the integration work. */
interface ActionLogRow {
  action_id: string;
  created_at: string;
  agent_id: string;
  session_id: string;
  tool_name: string;
  tool_args: string;
  decision: string;
  risk_score: number;
  reasoning: string;
  violated_policy: string | null;
  latency_ms: number;
  category: string | null;
  degraded: number;
  decided_by: string | null;
  retrieved_policies: string | null;
  pattern_notes: string | null;
}

export function rowToEvaluated(row: ActionLogRow): EvaluatedAction {
  const parse = <T,>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    action: {
      id: row.action_id,
      agentId: row.agent_id,
      toolName: row.tool_name,
      toolArgs: parse<Record<string, unknown>>(row.tool_args, {}),
      timestamp: Date.parse(row.created_at),
      sessionId: row.session_id,
    },
    result: {
      riskScore: row.risk_score,
      decision: (row.decision as EvaluatedAction['result']['decision']) ?? 'block',
      reasoning: row.reasoning,
      violatedPolicy: row.violated_policy ?? undefined,
      latencyMs: row.latency_ms,
    },
    // `decided_by` is 'rules' when the gateway's rule table answered without
    // reaching the engine. That split is the product's performance story.
    path: row.decided_by === 'rules' ? 'rule' : 'judge',
    category: row.category ?? undefined,
    retrievedPolicies: parse(row.retrieved_policies, undefined),
    patternNotes: parse(row.pattern_notes, undefined),
    degraded: row.degraded === 1,
    source: 'live',
  };
}

export class LiveProvider implements DataProvider {
  readonly mode = 'live' as const;
  readonly moments: DemoMoment[] = [];

  private seen: EvaluatedAction[] = [];
  private listeners = new Set<(a: EvaluatedAction) => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private since = 0;

  subscribe(onAction: (a: EvaluatedAction) => void) {
    this.listeners.add(onAction);
    return () => {
      this.listeners.delete(onAction);
    };
  }

  history() {
    return this.seen;
  }

  start() {
    if (this.poll) return;
    // Poll rather than SSE: the gateway has no event stream today, and a poll
    // degrades more gracefully on venue wifi than a dropped EventSource.
    this.poll = setInterval(() => void this.fetchNew(), 1000);
  }

  pause() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  reset() {
    this.pause();
    this.seen = [];
    this.since = 0;
  }

  private async fetchNew() {
    try {
      const res = await fetch(`${GATEWAY}/actions?since=${this.since}`, { cache: 'no-store' });
      if (!res.ok) return;
      const rows = (await res.json()) as ActionLogRow[];
      for (const row of rows) {
        const ev = rowToEvaluated(row);
        this.since = Math.max(this.since, ev.action.timestamp);
        this.seen = [...this.seen, ev];
        this.listeners.forEach((fn) => fn(ev));
      }
    } catch {
      // Silent: the feed shows a disconnected state via health(), and a noisy
      // console during a demo helps nobody.
    }
  }

  /** Live mode has no benchmark endpoint — the eval number is a P3 artifact
   *  produced offline, not something the running system reports. Returning null
   *  makes the analytics layer say so instead of inventing one. */
  async metrics(): Promise<BenchmarkMetrics | null> {
    return null;
  }

  async policies(): Promise<Policy[]> {
    try {
      // Through this app's own API route, not the engine directly: the engine
      // needs a bearer token the browser must never hold.
      const res = await fetch('/api/policies', { cache: 'no-store' });
      if (!res.ok) return [];
      const raw = (await res.json()) as {
        id: string;
        name: string;
        description: string;
        severity?: string;
        appliesTo?: string[];
        enforcedBy?: string;
        enabled?: boolean;
      }[];
      return raw.map((p) => ({ ...p, enabled: p.enabled ?? true }));
    } catch {
      return [];
    }
  }

  /** Liveness for both halves of the backend, so the UI can distinguish
   *  "nothing happening" from "nothing connected". */
  static async health() {
    const probe = async (url: string) => {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    };
    const [gateway, engine] = await Promise.all([
      probe(`${GATEWAY}/health`),
      probe(`${ENGINE}/health`),
    ]);
    return { gateway, engine };
  }
}
