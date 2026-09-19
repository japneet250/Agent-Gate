import type { AgentAction, EvalResult, SessionContext } from '@agentgate/shared-types';
import { evaluateStub } from './stub.js';

export type EvaluateFn = (
  action: AgentAction,
  context: SessionContext,
) => Promise<EvalResult>;

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
