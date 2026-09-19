import type { AgentAction, EvalResult } from '@agentgate/shared';
import { log } from './log.js';
import { reportError } from './monitoring.js';
import { configFromEnv, createRuleEngine, type RulesConfig } from './rules.js';

/** Who settled a call: our rules, the AI judge, or the fail-closed default when the judge was missing/unreachable. */
export type DecidedBy = 'rules' | 'judge' | 'fallback';

/** An EvalResult plus the extras the dashboard wants (all optional; the rule engine only sets `decidedBy`). */
export interface Verdict extends EvalResult {
  category?: string;
  retrievedPolicies?: unknown[];
  patternNotes?: unknown[];
  guardrails?: unknown[];
  /** True when an engine node fell back instead of using its model: trust the score less. */
  degraded?: boolean;
  decidedBy?: DecidedBy;
}

export type Evaluator = (action: AgentAction) => Promise<Verdict>;

// Same bands as Person 2's decision gate: 0-30 allow, 30-70 escalate, 70-100 block.
export const decide = (riskScore: number): EvalResult['decision'] =>
  riskScore >= 70 ? 'block' : riskScore >= 30 ? 'escalate' : 'allow';

// PLACEHOLDER: Person 2's AI judge plugs in here (POST /evaluate on the engine). Until then, calls that
// no rule catches are allowed.
const noJudge: Evaluator = async () => ({
  riskScore: 0,
  decision: 'allow',
  reasoning: 'no rule matched; AI judge not connected yet, allowing',
  latencyMs: 0,
  decidedBy: 'fallback',
});

/** Rules run first. Only calls that no rule matches are handed to the judge. */
export function createEvaluator(
  config: RulesConfig = configFromEnv(),
  judge: Evaluator = noJudge,
  isEnabled?: (ruleName: string) => boolean,
): Evaluator {
  const engine = createRuleEngine(config, isEnabled);
  return async (action) => {
    const start = performance.now();
    const verdict = engine.run(action);
    if (!verdict.matched) return { decidedBy: 'judge', ...(await judge(action)) };
    return {
      decidedBy: 'rules',
      riskScore: verdict.riskScore,
      decision: decide(verdict.riskScore),
      reasoning: verdict.reason,
      violatedPolicy: verdict.rules.join(','),
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
    };
  };
}

/**
 * Wraps an evaluator so every decision is also handed to `record` (the audit log). Recording never delays
 * or changes the decision: `record` is not awaited and its errors are swallowed and logged.
 */
export function withAuditLog(evaluate: Evaluator, record: (action: AgentAction, result: Verdict) => Promise<unknown> | void): Evaluator {
  return async (action) => {
    const result = await evaluate(action);
    try {
      Promise.resolve(record(action, result)).catch((err) => (log('audit log write failed:', err), reportError(err, 'audit-log')));
    } catch (err) {
      log('audit log write failed:', err);
      reportError(err, 'audit-log');
    }
    return result;
  };
}
