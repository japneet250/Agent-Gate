import type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared-types';
import { evaluateStub } from './stub.js';
import { createEngineEvaluate, engineBaseUrl, engineHealth, type EngineHealth } from './http.js';

export type EvaluateFn = (
  action: AgentAction,
  context: SessionContext,
) => Promise<EvalResult>;

/**
 * RESOLVED -- P2 rejected this. There is no third parameter: the engine picks
 * its judge from the AGENTGATE_JUDGE_MODEL environment variable instead
 * (packages/engine/INTEGRATION.md, "Environment").
 *
 * Consequence: the model comparison stays in P3's own judge wrapper
 * (../models/judge.ts) and does not go through the engine. That is not a
 * workaround -- pinning the model per-request is simply not something the
 * engine offers, and env-var selection cannot vary within a single run.
 *
 * Kept as a type alias only so nothing that imported it breaks.
 */
export type EvaluateOptions = { model?: string };

export type EngineKind = 'stub' | 'engine';

export function engineKind(): EngineKind {
  return process.env.AGENTGATE_ENGINE === 'engine' ? 'engine' : 'stub';
}

export type ResolvedEngine = {
  evaluate: EvaluateFn;
  kind: EngineKind;
  /** Present only when kind === 'engine'; carries the exact judge model id. */
  health?: EngineHealth;
};

/**
 * Resolves the evaluate() implementation.
 *
 * AGENTGATE_ENGINE=stub   (default) -> local rule stub, always runnable
 * AGENTGATE_ENGINE=engine           -> P2's Python service over HTTP
 *
 * P2's engine is a FastAPI service, not an npm package, so "is the engine
 * available" is a liveness question rather than an import question. We ask
 * /health first: an unreachable service returns kind 'stub', which is what makes
 * `--model=engine` refuse to run rather than quietly scoring the stub under the
 * engine's name.
 */
export async function resolveEvaluate(kind: EngineKind = engineKind()): Promise<ResolvedEngine> {
  if (kind === 'engine') {
    const baseUrl = engineBaseUrl();
    const health = await engineHealth(baseUrl);

    if (!health) {
      console.warn(
        `[evals] AGENTGATE_ENGINE=engine but no engine is answering at ${baseUrl}.\n` +
          `        Start it:  cd packages/engine && ./venv/bin/uvicorn server:app --port 8000\n` +
          `        Falling back to the stub.`,
      );
    } else {
      if (!health.openaiConfigured) {
        console.warn(
          `[evals] engine is up but reports openaiConfigured=false — it will degrade to\n` +
            `        fallbacks instead of judging. Set OPENAI_API_KEY in the repo-root .env.`,
        );
      }
      if (health.retrieval !== 'hybrid') {
        console.warn(
          `[evals] engine retrieval is "${health.retrieval}", not "hybrid" — semantic policy\n` +
            `        matching is off, so this run does not measure the engine at full strength.`,
        );
      }
      return { evaluate: createEngineEvaluate({ baseUrl }), kind: 'engine', health };
    }
  }
  return { evaluate: evaluateStub, kind: 'stub' };
}

export { evaluateStub };
export {
  createEngineEvaluate,
  engineBaseUrl,
  engineHealth,
  engineDegradedCount,
  resetEngineDegradedCount,
  resetEngineSessions,
  type EngineHealth,
} from './http.js';
