import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

/**
 * Load `.env` from the nearest ancestor that has one, so the engine picks up the
 * monorepo-root .env whether it is run from the repo root, from this package, or
 * imported by the gateway.
 */
function loadDotenv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), dir];
  for (const start of roots) {
    let cur = resolve(start);
    for (let i = 0; i < 6; i++) {
      const candidate = join(cur, '.env');
      if (existsSync(candidate)) {
        loadEnv({ path: candidate });
        return;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
}
loadDotenv();

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
};

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  classifierModel: process.env.AGENTGATE_CLASSIFIER_MODEL ?? 'gpt-4o-mini',
  judgeModel: process.env.AGENTGATE_JUDGE_MODEL ?? 'gpt-4o',
  embedModel: process.env.AGENTGATE_EMBED_MODEL ?? 'text-embedding-3-small',

  /** Per-call latency budgets. The judge gets the most room; it does the reasoning. */
  classifierTimeoutMs: num(process.env.AGENTGATE_CLASSIFIER_TIMEOUT_MS, 3000),
  judgeTimeoutMs: num(process.env.AGENTGATE_JUDGE_TIMEOUT_MS, 8000),
  embedTimeoutMs: num(process.env.AGENTGATE_EMBED_TIMEOUT_MS, 5000),
  /** Whole-pipeline budget. Exceeding it is a guardrail violation, not a crash. */
  latencyBudgetMs: num(process.env.AGENTGATE_LATENCY_BUDGET_MS, 12000),

  retries: num(process.env.AGENTGATE_RETRIES, 1),
  circuitBreakerThreshold: num(process.env.AGENTGATE_BREAKER_THRESHOLD, 3),
  circuitBreakerCooldownMs: num(process.env.AGENTGATE_BREAKER_COOLDOWN_MS, 30000),

  /** Decision Gate thresholds. */
  allowBelow: num(process.env.AGENTGATE_ALLOW_BELOW, 30),
  blockAtOrAbove: num(process.env.AGENTGATE_BLOCK_AT, 70),

  /** Pattern Detector thresholds. */
  sessionSpendLimit: num(process.env.AGENTGATE_SESSION_SPEND_LIMIT, 5000),
  repeatedCallLimit: num(process.env.AGENTGATE_REPEATED_CALL_LIMIT, 10),
  dataAccessLimit: num(process.env.AGENTGATE_DATA_ACCESS_LIMIT, 25),
  permissionRequestLimit: num(process.env.AGENTGATE_PERMISSION_LIMIT, 3),

  /** Consistency guardrail: max allowed score drift for a repeated action. */
  consistencyDriftLimit: num(process.env.AGENTGATE_CONSISTENCY_DRIFT, 25),

  /** Hybrid retrieval blend. */
  topK: num(process.env.AGENTGATE_TOP_K, 5),
  denseWeight: num(process.env.AGENTGATE_DENSE_WEIGHT, 0.7),
  sparseWeight: num(process.env.AGENTGATE_SPARSE_WEIGHT, 0.3),
  categoryBoost: num(process.env.AGENTGATE_CATEGORY_BOOST, 0.15),

  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
    baseUrl: process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com',
  },
};

export const hasOpenAI = () => config.openaiApiKey.length > 0;
