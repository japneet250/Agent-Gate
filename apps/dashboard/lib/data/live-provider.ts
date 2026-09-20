import type {
  BenchmarkMetrics,
  DataProvider,
  DemoMoment,
  EvaluatedAction,
  Policy,
} from './types';
import { offlineBenchmark } from './mock-provider';

const DECISIONS = ['allow', 'escalate', 'block'] as const;

const EMPTY_CONFUSION = Object.fromEntries(
  DECISIONS.map((d) => [d, Object.fromEntries(DECISIONS.map((e) => [e, 0]))]),
) as BenchmarkMetrics['confusion'];

/** The report stores per-class metrics as an array keyed by `decision`; the UI
 *  wants them keyed by decision. */
function normalisePerClass(raw: unknown): BenchmarkMetrics['perClass'] {
  const empty = { precision: 0, recall: 0, f1: 0, support: 0 };
  const out = Object.fromEntries(DECISIONS.map((d) => [d, { ...empty }])) as BenchmarkMetrics['perClass'];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      const d = p?.decision as (typeof DECISIONS)[number] | undefined;
      if (d && d in out) {
        out[d] = {
          precision: p.precision ?? 0,
          recall: p.recall ?? 0,
          f1: p.f1 ?? 0,
          support: p.support ?? 0,
        };
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const d of DECISIONS) {
      const p = (raw as Record<string, typeof empty>)[d];
      if (p) out[d] = { ...empty, ...p };
    }
  }
  return out;
}

/** byCategory arrives as { safe: {total, accuracy}, ... }. */
function normaliseCategories(raw: unknown): BenchmarkMetrics['byCategory'] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, { total?: number; accuracy?: number }>).map(
    ([category, v]) => ({ category, n: v?.total ?? 0, accuracy: v?.accuracy ?? 0 }),
  );
}

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

  /**
   * The benchmark is an offline artifact: it comes from running the labelled
   * scenario suite through the engine, and a running gateway has no endpoint
   * that reports it. That does not make it unshowable in live mode — it makes
   * it a measurement with a date on it, like any benchmark.
   *
   * So live mode serves the same committed `--model=engine` run that mock mode
   * does, and the analytics page states where it came from and when. Returning
   * null instead left the main measurement screen empty during a live demo,
   * which is a worse failure than showing a real number with its provenance
   * attached. The NOT A PRODUCT NUMBER guard still applies: a stub run is
   * labelled as one here exactly as it is in mock mode.
   */
  async metrics(): Promise<BenchmarkMetrics | null> {
    try {
      // Read from disk through this app's API route, not from the bundle. A
      // benchmark baked in at build time cannot change when the harness is
      // re-run, which made re-measuring invisible until someone rebuilt.
      const res = await fetch('/api/benchmark', { cache: 'no-store' });
      if (res.ok) {
        const b = await res.json();
        if (b && typeof b.accuracy === 'number') {
          return {
            accuracy: b.accuracy,
            macroF1: b.macroF1 ?? 0,
            weightedF1: b.weightedF1 ?? undefined,
            perClass: normalisePerClass(b.perClass),
            confusion: b.confusion ?? EMPTY_CONFUSION,
            byCategory: normaliseCategories(b.byCategory),
            latency: b.latency ?? { meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
            scenarioCount: b.scenarioCount ?? 0,
            isProductNumber: Boolean(b.isProductNumber),
            engine: b.engine ?? 'unknown',
            generatedAt: b.generatedAt ?? b.fileModifiedAt ?? '',
          };
        }
      }
    } catch {
      // Fall through to the committed baseline below.
    }
    // The route is the source of truth; the bundled copy is the fallback so a
    // demo still has its numbers if the filesystem read fails.
    return offlineBenchmark();
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
