import { config } from './config.ts';
import { policyExists } from './policyStore.ts';
import type { SessionState } from './store/index.ts';
import type { GraphState, GuardrailEvent, JudgeVerdict, RetrievedPolicy } from './state.ts';

/**
 * The evaluator needs evaluation too. These run on the Risk Judge's own output
 * before it is allowed to influence a decision.
 */

/** Key order must not change an action's identity. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

/**
 * Identity of a specific action — tool name plus argument VALUES.
 *
 * Deliberately value-based, not shape-based. Thirty purchase orders to thirty
 * different vendors are thirty distinct actions, not a loop; and a benign email
 * and one carrying an SSN must be allowed to score differently. Keying on the
 * shape of the arguments would collapse both cases and make the loop detector
 * and the consistency guardrail fire on ordinary work.
 */
export function fingerprint(toolName: string, args: Record<string, any>): string {
  return `${toolName}:${canonical(args ?? {})}`;
}

export interface ValidatedVerdict {
  verdict: JudgeVerdict;
  guardrails: GuardrailEvent[];
}

/**
 * 1. Structured output conformance — score must be a number in 0-100, decision
 *    comes from the gate, reasoning must be non-empty.
 * 2. No hallucinated policy references — a cited policy must exist in the store
 *    AND have been among the ones retrieved for this action.
 */
export function validateJudgeOutput(raw: unknown, policies: RetrievedPolicy[]): ValidatedVerdict {
  const guardrails: GuardrailEvent[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;

  let riskScore = Number(obj.risk_score);
  if (!Number.isFinite(riskScore)) {
    guardrails.push({
      rule: 'structured_output',
      detail: `risk_score was not a number (${JSON.stringify(obj.risk_score)}); defaulted to 50.`,
    });
    riskScore = 50;
  } else if (riskScore < 0 || riskScore > 100) {
    guardrails.push({
      rule: 'structured_output',
      detail: `risk_score ${riskScore} out of range; clamped to 0-100.`,
    });
    riskScore = Math.max(0, Math.min(100, riskScore));
  }

  let reasoning = String(obj.reasoning ?? '').trim();
  if (!reasoning) {
    guardrails.push({ rule: 'structured_output', detail: 'Judge returned empty reasoning.' });
    reasoning = 'Judge returned no reasoning.';
  }

  const cited = String(obj.violated_policy ?? '').trim();
  let violatedPolicy: string | undefined;
  if (cited) {
    const retrieved = policies.find((p) => p.name.toLowerCase() === cited.toLowerCase());
    if (retrieved) {
      violatedPolicy = retrieved.name;
    } else if (policyExists(cited)) {
      guardrails.push({
        rule: 'policy_grounding',
        detail: `Judge cited "${cited}", which exists but was not retrieved for this action; citation dropped.`,
      });
    } else {
      guardrails.push({
        rule: 'policy_grounding',
        detail: `Judge cited "${cited}", which is not in the policy store; citation dropped (hallucination).`,
      });
    }
  }

  return { verdict: { riskScore, reasoning, violatedPolicy }, guardrails };
}

/**
 * 3. Consistency — the identical action twice in one session should not get
 *    wildly different scores. On drift we take the stricter score, so an inconsistent
 *    judge can never be the reason something dangerous gets through.
 */
export function enforceConsistency(
  verdict: JudgeVerdict,
  session: SessionState,
  fp: string,
): ValidatedVerdict {
  const prior = session.scoreHistory.filter((h) => h.fingerprint === fp);
  if (prior.length === 0) return { verdict, guardrails: [] };

  const priorMax = Math.max(...prior.map((h) => h.riskScore));
  const drift = Math.abs(priorMax - verdict.riskScore);
  if (drift <= config.consistencyDriftLimit) return { verdict, guardrails: [] };

  const stricter = Math.max(priorMax, verdict.riskScore);
  return {
    verdict: { ...verdict, riskScore: stricter },
    guardrails: [
      {
        rule: 'consistency',
        detail: `Same action scored ${verdict.riskScore} now vs ${priorMax} earlier this session (drift ${drift}); took the stricter score ${stricter}.`,
      },
    ],
  };
}

/**
 * 4. Latency budget — if the pipeline blew its budget we say so on the result,
 *    so the gateway can decide whether to trust it or fall back to rules only.
 */
export function checkLatencyBudget(state: GraphState): GuardrailEvent[] {
  const elapsed = Date.now() - state.startedAt;
  if (elapsed <= config.latencyBudgetMs) return [];
  return [
    {
      rule: 'latency_budget',
      detail: `Evaluation took ${elapsed}ms, over the ${config.latencyBudgetMs}ms budget.`,
    },
  ];
}
