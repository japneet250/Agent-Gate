import type {
  BenchmarkMetrics,
  DataProvider,
  DemoMoment,
  EvaluatedAction,
  Policy,
} from './types';
import raw from './fixtures.generated.json';

/**
 * Deterministic replay of the real eval suite.
 *
 * Every row came from packages/evals/scenarios.json scored by a real
 * --model=engine run (see scripts/generate-fixtures.mjs). Nothing is invented,
 * which is what makes the demo defensible when someone asks where a number came
 * from — and what makes it survive a dead venue wifi.
 *
 * Replay state is held in memory, never in browser storage: a half-finished
 * replay restored from a previous session is a worse failure mode on stage than
 * simply starting over.
 */

type Fixtures = {
  actions: (EvaluatedAction & { argsSummary?: string; hasMeasuredResult?: boolean })[];
  metrics: BenchmarkMetrics | null;
  policies: Policy[];
  moments: DemoMoment[];
  provenance: {
    scenariosFile: string;
    reportFile: string;
    scenarioCount: number;
    generatedAt: string;
    note: string;
  };
};

const fixtures = raw as unknown as Fixtures;

export const provenance = fixtures.provenance;

/**
 * The benchmark from the committed eval run. Shared with live mode, which has
 * no endpoint of its own for it — see LiveProvider.metrics().
 */
export const offlineBenchmark = (): BenchmarkMetrics | null => fixtures.metrics;

/** Pacing. Fast enough to feel live, slow enough to read a block reason.
 *  The burst interval is what the 30-action performance test exercises. */
const NORMAL_MS = 900;
const BURST_MS = 90;

export class MockProvider implements DataProvider {
  readonly mode = 'mock' as const;
  readonly moments = fixtures.moments;

  private seen: EvaluatedAction[] = [];
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(a: EvaluatedAction) => void>();
  private burstUntil = 0;

  subscribe(onAction: (a: EvaluatedAction) => void) {
    this.listeners.add(onAction);
    return () => {
      this.listeners.delete(onAction);
    };
  }

  history() {
    return this.seen;
  }

  async metrics() {
    return fixtures.metrics;
  }

  async policies() {
    return fixtures.policies;
  }

  start() {
    if (this.timer) return;
    this.tick();
  }

  pause() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reset() {
    this.pause();
    this.cursor = 0;
    this.seen = [];
    this.burstUntil = 0;
  }

  /** Jump the replay to a named demo moment, emitting its lead-in rows at once
   *  so the moment lands in context rather than cold. */
  jumpTo(momentId: string) {
    const moment = fixtures.moments.find((m) => m.id === momentId);
    if (!moment) return;
    const firstId = moment.actionIds[0];
    const target = fixtures.actions.findIndex((a) => a.action.id === firstId);
    if (target < 0) return;

    this.pause();
    // Seed a little context before the moment so the feed is not empty.
    const LEAD_IN = 4;
    const from = Math.max(0, target - LEAD_IN);
    this.seen = fixtures.actions.slice(from, target).map(normalise);
    this.cursor = target;
    this.start();
  }

  /** Replay the rest of the current session's actions rapidly — the burst the
   *  procurement story needs, and the 60fps test case. */
  burst(ms = 4000) {
    this.burstUntil = Date.now() + ms;
    if (!this.timer) this.start();
  }

  private tick = () => {
    if (this.cursor >= fixtures.actions.length) {
      this.timer = null;
      return;
    }
    const next = normalise(fixtures.actions[this.cursor++]);
    this.seen = [...this.seen, next];
    this.listeners.forEach((fn) => fn(next));

    const bursting = Date.now() < this.burstUntil;
    this.timer = setTimeout(this.tick, bursting ? BURST_MS : NORMAL_MS);
  };
}

function normalise(a: EvaluatedAction): EvaluatedAction {
  return a;
}

export const mockActionCount = fixtures.actions.length;
