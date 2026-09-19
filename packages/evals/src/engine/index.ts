import type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared-types';
import { evaluateStub } from './stub.js';

export type EvaluateFn = (
  action: AgentAction,
  context: SessionContext,
) => Promise<EvalResult>;

/**
 * TODO: confirm with P2 — proposed third parameter so the engine can be asked
 * to decide with a specific model:
 *
 *   evaluate(action, context, opts?: { model?: string }): Promise<EvalResult>
 *
 * Until P2 confirms, the model comparison runs through P3's own judge wrapper
 * (../models/judge.ts) instead of the engine, so the two models differ only in
 * the model itself. If P2 adopts the option, the comparison should move behind
 * evaluate() and the wrapper becomes redundant.
 */
export type EvaluateOptions = { model?: string };

export type EngineKind = 'stub' | 'engine';

export function engineKind(): EngineKind {
  return process.env.AGENTGATE_ENGINE === 'engine' ? 'engine' : 'stub';
}

/**
 * Resolves the evaluate() implementation.
 *
 * AGENTGATE_ENGINE=stub   (default) -> local rule stub, always runnable
 * AGENTGATE_ENGINE=engine           -> P2's real engine
 *
 * TODO: replace the dynamic import below with a static
 * `import { evaluate } from '@agentgate/engine'` once P2 publishes it.
 */
export async function resolveEvaluate(kind: EngineKind = engineKind()): Promise<{
  evaluate: EvaluateFn;
  kind: EngineKind;
}> {
  if (kind === 'engine') {
    try {
      const mod: Record<string, unknown> = await import(
        /* @vite-ignore */ '@agentgate/engine' as string
      );
      const evaluate = mod.evaluate as EvaluateFn | undefined;
      if (typeof evaluate !== 'function') {
        throw new Error("@agentgate/engine does not export evaluate()");
      }
      return { evaluate, kind: 'engine' };
    } catch (err) {
      console.warn(
        `[evals] AGENTGATE_ENGINE=engine but the real engine is not usable yet (${(err as Error).message}); falling back to the stub.`,
      );
    }
  }
  return { evaluate: evaluateStub, kind: 'stub' };
}

export { evaluateStub };
