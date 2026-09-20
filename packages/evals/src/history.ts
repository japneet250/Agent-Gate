import { MongoClient } from 'mongodb';
import type { Metrics } from './metrics.js';
import type { SuiteResult } from './score.js';

/**
 * Eval-run history in MongoDB Atlas.
 *
 * SCOPE: P3's eval runs only. Agent action logs are P1's D1 store -- nothing
 * about a real agent action belongs in here.
 *
 * Degrades exactly like the observability backends: no connection string means
 * a warning and a skip, never a failed run.
 */
export type EvalRunDoc = {
  timestamp: Date;
  model: string;
  scenarioHash: string;
  scenarioCount: number;
  category: string;
  accuracy: number;
  macroF1: number;
  weightedF1: number;
  /** Per-decision-class precision / recall / F1. */
  precision: Record<string, number>;
  recall: Record<string, number>;
  f1: Record<string, number>;
  confusion: Metrics['confusion'];
  latency: SuiteResult['latency'];
  reportPath: string;
  passed: boolean;
  gitBranch?: string;
};

const DB_NAME = process.env.MONGODB_DB ?? 'agentgate';
const COLLECTION = 'eval_runs';

export function historyEnabled(): boolean {
  return Boolean(process.env.MONGODB_URI);
}

export function buildRunDoc(params: {
  model: string;
  metrics: Metrics;
  latency: SuiteResult['latency'];
  scenarioHash: string;
  scenarioCount: number;
  category: string;
  reportPath: string;
  passed: boolean;
}): EvalRunDoc {
  const byClass = (pick: (c: Metrics['perClass'][number]) => number) =>
    Object.fromEntries(params.metrics.perClass.map((c) => [c.decision, pick(c)]));

  return {
    timestamp: new Date(),
    model: params.model,
    scenarioHash: params.scenarioHash,
    scenarioCount: params.scenarioCount,
    category: params.category,
    accuracy: params.metrics.accuracy,
    macroF1: params.metrics.macroF1,
    weightedF1: params.metrics.weightedF1,
    precision: byClass((c) => c.precision),
    recall: byClass((c) => c.recall),
    f1: byClass((c) => c.f1),
    confusion: params.metrics.confusion,
    latency: params.latency,
    reportPath: params.reportPath,
    passed: params.passed,
    gitBranch: process.env.GIT_BRANCH,
  };
}

/** Writes one run. Returns the inserted id, or undefined when history is off. */
export async function recordRun(doc: EvalRunDoc): Promise<string | undefined> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[history] MONGODB_URI not set — eval run not persisted');
    return undefined;
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const result = await client
      .db(DB_NAME)
      .collection<EvalRunDoc>(COLLECTION)
      .insertOne(doc);
    return result.insertedId.toString();
  } catch (err) {
    // A history outage must never fail an eval run.
    console.warn(`[history] could not record run: ${(err as Error).message}`);
    return undefined;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Recent runs for the same scenario set, newest first. */
export async function recentRuns(scenarioHash: string, limit = 10): Promise<EvalRunDoc[]> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return [];

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    return await client
      .db(DB_NAME)
      .collection<EvalRunDoc>(COLLECTION)
      .find({ scenarioHash })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.warn(`[history] could not read history: ${(err as Error).message}`);
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}
