import 'dotenv/config';

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  classifierModel: process.env.AGENTGATE_CLASSIFIER_MODEL ?? 'gpt-4o-mini',
  judgeModel: process.env.AGENTGATE_JUDGE_MODEL ?? 'gpt-4o',
  embedModel: process.env.AGENTGATE_EMBED_MODEL ?? 'text-embedding-3-small',

  /** Guardrail: if the whole pipeline exceeds this, we bail out to a safe default. */
  latencyBudgetMs: Number(process.env.AGENTGATE_LATENCY_BUDGET_MS ?? 2000),

  /** Decision Gate thresholds. */
  allowBelow: 30,
  blockAtOrAbove: 70,

  /** Pattern Detector thresholds. */
  sessionSpendLimit: Number(process.env.AGENTGATE_SESSION_SPEND_LIMIT ?? 5000),
  repeatedCallLimit: Number(process.env.AGENTGATE_REPEATED_CALL_LIMIT ?? 10),
  dataAccessLimit: Number(process.env.AGENTGATE_DATA_ACCESS_LIMIT ?? 25),

  topK: 5,

  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
    baseUrl: process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com',
  },
};

export const hasOpenAI = () => config.openaiApiKey.length > 0;
