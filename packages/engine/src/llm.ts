import OpenAI from 'openai';
import { config } from './config.ts';

let client: OpenAI | null = null;

export function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

/** Reject a hung LLM call so the latency-budget guardrail can fire. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms),
    ),
  ]);
}
