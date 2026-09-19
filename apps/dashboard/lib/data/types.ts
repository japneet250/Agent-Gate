/**
 * The contract boundary.
 *
 * These mirror `packages/shared/types.ts` (P1/P2's copy) and
 * `packages/shared-types/src/index.ts` (P3's). The dashboard deliberately
 * re-declares them instead of importing across the workspace: it has to build
 * and run while the rest of the monorepo is mid-integration, and a cross-package
 * import would couple the demo's survival to whichever branch is checked out.
 *
 * If the shared contract changes, this file is the ONE place to update.
 *
 * Known divergence between the two upstream copies, resolved here:
 *   - `timestamp` is `number` (epoch ms) on the wire. P3's TS says number,
 *     P2's python says datetime, P1's TS says Date. JSON only carries one of
 *     those honestly, so the adapter normalises on parse.
 */

export type Decision = 'allow' | 'block' | 'escalate';

export interface AgentAction {
  id: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  timestamp: number;
  sessionId: string;
}

export interface EvalResult {
  /** 0-100 */
  riskScore: number;
  decision: Decision;
  reasoning: string;
  violatedPolicy?: string;
  latencyMs: number;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  severity?: string;
  appliesTo?: string[];
  enforcedBy?: string;
  enabled: boolean;
}

/** Which layer decided. The gateway's rule table answers in <10ms; the engine's
 *  judge takes ~2s. The split is the product's whole performance story. */
export type DecisionPath = 'rule' | 'judge';

/** A retrieved policy as the engine reports it. Note it carries name + score
 *  only — the engine does not serialise the policy text (flagged to P2). */
export interface RetrievedPolicy {
  name: string;
  score: number;
}

/** One evaluated action: what the agent tried, and what AgentGate did about it.
 *  This is the shape the feed renders and the shape D1's `action_logs` row maps
 *  onto, so LiveProvider is a field rename rather than a redesign. */
export interface EvaluatedAction {
  action: AgentAction;
  result: EvalResult;
  path: DecisionPath;
  category?: string;
  retrievedPolicies?: RetrievedPolicy[];
  patternNotes?: string[];
  degraded?: boolean;

  /** ---- provenance, for honesty in the UI ---- */
  /** Where this row came from. `fixture` rows are replayed real eval results. */
  source: 'fixture' | 'live';
  /** The eval suite's ground-truth label, when this row came from a scenario. */
  expected?: Decision;
  /** True when the engine's decision differs from the labelled one. The UI
   *  surfaces this rather than hiding it — it is the measured 70% made visible. */
  diverges?: boolean;
  /** The originating scenario id, so any claim can be traced to source data. */
  scenarioId?: string;
}

/** Headline eval numbers, read from packages/evals/report.json at build time.
 *  Never hardcoded — if the report changes, these change. */
export interface BenchmarkMetrics {
  accuracy: number;
  macroF1: number;
  weightedF1?: number;
  perClass: Record<Decision, { precision: number; recall: number; f1: number; support: number }>;
  confusion: Record<Decision, Record<Decision, number>>;
  byCategory: { category: string; n: number; accuracy: number }[];
  latency: { meanMs: number; p50Ms: number; p95Ms: number; maxMs: number };
  scenarioCount: number;
  /** True ONLY for a --model=engine run. Anything else is an eval-engineering
   *  artifact and must not be presented as AgentGate's score. */
  isProductNumber: boolean;
  engine: string;
  generatedAt: string;
}

export interface DemoMoment {
  id: string;
  title: string;
  subtitle: string;
  /** Indices into the replay stream that make up this moment. */
  actionIds: string[];
}

export interface Fixtures {
  actions: EvaluatedAction[];
  metrics: BenchmarkMetrics;
  policies: Policy[];
  moments: DemoMoment[];
  /** Provenance banner for the UI: which real files this was derived from. */
  provenance: {
    scenariosFile: string;
    reportFile: string;
    scenarioCount: number;
    generatedAt: string;
    note: string;
  };
}

/** What every provider must implement. Mock and live are interchangeable. */
export interface DataProvider {
  readonly mode: 'mock' | 'live';
  /** Subscribe to the action stream. Returns an unsubscribe fn. */
  subscribe(onAction: (a: EvaluatedAction) => void): () => void;
  /** Everything already known, for first paint. */
  history(): EvaluatedAction[];
  metrics(): Promise<BenchmarkMetrics | null>;
  policies(): Promise<Policy[]>;
  /** Replay control — mock only; live providers no-op. */
  start(): void;
  pause(): void;
  reset(): void;
  jumpTo?(momentId: string): void;
  readonly moments: DemoMoment[];
}
