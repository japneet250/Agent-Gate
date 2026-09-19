import type { EvaluateLike } from '@agentgate/observability';
import type { DecisionPath } from '@agentgate/observability';
import { resolveEvaluate, type EngineKind } from '../engine/index.js';
import { createJudge, hasApiKey, API_KEY_ENV, type Provider } from './judge.js';

/**
 * The models the harness can score against.
 *
 * Model ids are env-overridable on purpose: provider model names move faster
 * than a hackathon repo does, and a stale hardcoded id is a silent failure.
 * Set OPENAI_JUDGE_MODEL / GEMINI_JUDGE_MODEL to pin exact versions.
 */
export const MODEL_IDS = {
  openai: process.env.OPENAI_JUDGE_MODEL ?? 'gpt-4o-mini',
  gemini: process.env.GEMINI_JUDGE_MODEL ?? 'gemini-2.5-flash',
} as const;

export type ModelName = 'stub' | 'engine' | Provider;

export type ResolvedModel = {
  name: ModelName;
  /** Label used in reports and trace metadata. */
  label: string;
  evaluate: EvaluateLike;
  path: DecisionPath;
};

export type ResolveOutcome =
  | { ok: true; model: ResolvedModel }
  | { ok: false; name: ModelName; reason: string };

export async function resolveModel(name: ModelName): Promise<ResolveOutcome> {
  if (name === 'stub' || name === 'engine') {
    const resolved = await resolveEvaluate(name as EngineKind);
    if (name === 'engine' && resolved.kind !== 'engine') {
      return { ok: false, name, reason: 'P2 engine does not export evaluate() yet' };
    }
    return {
      ok: true,
      model: { name, label: resolved.kind, evaluate: resolved.evaluate, path: 'rule' },
    };
  }

  if (!hasApiKey(name)) {
    return { ok: false, name, reason: `${API_KEY_ENV[name]} not set` };
  }

  const model = MODEL_IDS[name];
  return {
    ok: true,
    model: {
      name,
      label: `${name}:${model}`,
      evaluate: createJudge({ provider: name, model }),
      path: 'judge',
    },
  };
}

export function parseModelNames(raw: string | undefined): ModelName[] {
  if (!raw) return ['stub'];
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ModelName[];
  return names.length > 0 ? names : ['stub'];
}
