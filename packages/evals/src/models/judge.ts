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

function parseJudgeOutput(text: string | undefined): JudgeOutput {
  if (!text) throw new Error('judge returned an empty response');
  return JSON.parse(text) as JudgeOutput;
}

function openaiJudge(model: string): Judge {
  // OPENAI_BASE_URL lets the verifier point this at a local mock.
  const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL });
  return async (action, context) => {
    const startedAt = performance.now();
    const res = await client.chat.completions.create({
      model,
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
    });
    return toEvalResult(
      parseJudgeOutput(res.choices[0]?.message?.content ?? undefined),
      Math.round(performance.now() - startedAt),
    );
  };
}

function geminiJudge(model: string): Judge {
  const client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // GEMINI_BASE_URL lets the verifier point this at a local mock.
    ...(process.env.GEMINI_BASE_URL
      ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } }
      : {}),
  });
  return async (action, context) => {
    const startedAt = performance.now();
    const res = await client.models.generateContent({
      model,
      contents: buildJudgeInput(action, context),
      config: {
        systemInstruction: JUDGE_SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        // Gemini's own structured-output mechanism, so neither provider is
        // being asked to hold the format together with prompt text alone.
        responseSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
      },
    });
    return toEvalResult(
      parseJudgeOutput(res.text),
      Math.round(performance.now() - startedAt),
    );
  };
}

export function createJudge(config: JudgeConfig): Judge {
  return config.provider === 'openai'
    ? openaiJudge(config.model)
    : geminiJudge(config.model);
}

/** Which env var holds each provider's key. */
export const API_KEY_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export function hasApiKey(provider: Provider): boolean {
  return Boolean(process.env[API_KEY_ENV[provider]]);
}
