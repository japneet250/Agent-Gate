import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import {
  decisionForRiskScore,
  type AgentAction,
  type EvalResult,
  type SessionContext,
} from '@agentgate/shared-types';
import {
  buildJudgeInput,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
  type JudgeOutput,
} from './prompt.js';
import {
  DEFAULT_RETRY,
  JudgeInvalidOutput,
  withRetry,
  type RetryOptions,
} from './errors.js';

/**
 * A thin, P3-owned LLM judge used only for the model comparison.
 *
 * This deliberately does NOT go through P2's engine: the point is to compare
 * two models on identical input, which needs a path where the model is the only
 * variable. Once evaluate() takes a model option, the comparison should move
 * behind it -- see the TODO in ../engine/index.ts.
 */
export type Provider = 'openai' | 'gemini';

export type JudgeConfig = {
  provider: Provider;
  /** Exact model id; the caller resolves it from env or a flag. */
  model: string;
  retry?: RetryOptions;
  /** Called when a request is retried, so the harness can report the reason. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
};

export type Judge = (action: AgentAction, context: SessionContext) => Promise<EvalResult>;

function toEvalResult(raw: JudgeOutput, latencyMs: number): EvalResult {
  // Clamp, then trust the band over the model's own label: a model that says
  // "block" with a risk of 12 has contradicted itself, and the band is the
  // thing the rest of the system is calibrated against.
  const riskScore = Math.max(0, Math.min(100, Math.round(raw.riskScore)));
  const banded = decisionForRiskScore(riskScore);
  const violated = raw.violatedPolicy?.trim();
  return {
    riskScore,
    decision: banded,
    reasoning:
      banded === raw.decision
        ? raw.reasoning
        : `${raw.reasoning} [model said ${raw.decision}; risk ${riskScore} banded to ${banded}]`,
    violatedPolicy: !violated || violated === 'none' ? undefined : violated,
    latencyMs,
  };
}

const DECISIONS = new Set(['allow', 'escalate', 'block']);

/**
 * Validates the provider's output against the contract we asked for.
 *
 * Anything that fails here is a schema-conformance problem, not a judgement
 * problem, so it is raised as JudgeInvalidOutput and bucketed separately.
 */
function parseJudgeOutput(text: string | undefined): JudgeOutput {
  if (!text || !text.trim()) {
    throw new JudgeInvalidOutput('provider returned an empty response', text);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JudgeInvalidOutput('provider returned text that is not valid JSON', text);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new JudgeInvalidOutput('provider returned JSON that is not an object', text);
  }

  const o = parsed as Record<string, unknown>;
  if (typeof o.riskScore !== 'number' || !Number.isFinite(o.riskScore)) {
    throw new JudgeInvalidOutput('riskScore missing or not a number', text);
  }
  if (typeof o.decision !== 'string' || !DECISIONS.has(o.decision)) {
    throw new JudgeInvalidOutput(`decision missing or not one of allow/escalate/block`, text);
  }
  if (typeof o.reasoning !== 'string') {
    throw new JudgeInvalidOutput('reasoning missing or not a string', text);
  }

  return {
    riskScore: o.riskScore,
    decision: o.decision as JudgeOutput['decision'],
    reasoning: o.reasoning,
    violatedPolicy: typeof o.violatedPolicy === 'string' ? o.violatedPolicy : 'none',
  };
}

function openaiJudge(config: JudgeConfig): Judge {
  // OPENAI_BASE_URL lets the verifier point this at a local mock.
  //
  // maxRetries: 0 is deliberate. The OpenAI SDK retries twice by default, which
  // would compound with our own policy into up to 8 requests per scenario and
  // make quota use unpredictable. One bounded retry policy, applied here.
  const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, maxRetries: 0 });
  const retry = { ...(config.retry ?? DEFAULT_RETRY), onRetry: config.onRetry };

  return async (action, context) => {
    const startedAt = performance.now();
    // Only the network call is retried; a schema failure is deterministic and
    // retrying it just burns quota.
    const res = await withRetry(
      () =>
        client.chat.completions.create({
          model: config.model,
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: buildJudgeInput(action, context) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'agentgate_decision',
              strict: true,
              schema: { ...JUDGE_SCHEMA, additionalProperties: false },
            },
          },
        }),
      retry,
    );
    return toEvalResult(
      parseJudgeOutput(res.choices[0]?.message?.content ?? undefined),
      Math.round(performance.now() - startedAt),
    );
  };
}

function geminiJudge(config: JudgeConfig): Judge {
  const client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // GEMINI_BASE_URL lets the verifier point this at a local mock.
    ...(process.env.GEMINI_BASE_URL
      ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } }
      : {}),
  });
  const retry = { ...(config.retry ?? DEFAULT_RETRY), onRetry: config.onRetry };

  return async (action, context) => {
    const startedAt = performance.now();
    const res = await withRetry(
      () =>
        client.models.generateContent({
          model: config.model,
          contents: buildJudgeInput(action, context),
          config: {
            systemInstruction: JUDGE_SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            // Gemini's own structured-output mechanism, so neither provider is
            // being asked to hold the format together with prompt text alone.
            responseSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
          },
        }),
      retry,
    );
    return toEvalResult(
      parseJudgeOutput(res.text),
      Math.round(performance.now() - startedAt),
    );
  };
}

export function createJudge(config: JudgeConfig): Judge {
  return config.provider === 'openai' ? openaiJudge(config) : geminiJudge(config);
}

/** Which env var holds each provider's key. */
export const API_KEY_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export function hasApiKey(provider: Provider): boolean {
  return Boolean(process.env[API_KEY_ENV[provider]]);
}
