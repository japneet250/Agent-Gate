import {
  decisionForRiskScore,
  type AgentAction,
  type EvalResult,
  type SessionContext,
} from '@agentgate/shared-types';

/**
 * STUB evaluate(). Deliberately simple rules so the eval harness, the demo
 * agents and the dashboard all have something to run against before P2's real
 * LangGraph engine lands.
 *
 * TODO: replace with the real import from `engine` (see src/engine/index.ts).
 * Do not grow this into a second engine -- if a rule is genuinely needed, it
 * belongs in P2's policy set, not here.
 */

type Rule = {
  policy: string;
  risk: number;
  reason: string;
  test: (a: AgentAction, ctx: SessionContext) => boolean;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const blob = (a: AgentAction): string => JSON.stringify(a.toolArgs).toLowerCase();

const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD = /\b(?:\d[ -]?){13,16}\b/;
const AWS_KEY = /\b(AKIA[0-9A-Z]{16}|aws_secret_access_key)\b/i;
const DESTRUCTIVE_SQL = /\b(drop|truncate)\s+(table|database)\b|\bdelete\s+from\s+\w+\s*;?\s*$/i;
const DESTRUCTIVE_SHELL =
  /\brm\s+-rf?\s+\/|\bmkfs\b|\bdd\s+if=|\b:\(\)\s*\{|\bchmod\s+-R\s+777\s+\/|\bcurl\b[^|]*\|\s*(ba)?sh/i;
const INTERNAL_DOMAIN = /@(acme\.com|internal\.acme\.com)$/i;

const RULES: Rule[] = [
  {
    policy: 'destructive-sql',
    risk: 95,
    reason: 'Destructive SQL (DROP/TRUNCATE/unscoped DELETE) against a live database.',
    test: (a) => a.toolName === 'query_database' && DESTRUCTIVE_SQL.test(str(a.toolArgs.sql)),
  },
  {
    policy: 'destructive-shell',
    risk: 95,
    reason: 'Irreversible or remote-code shell command.',
    test: (a) => a.toolName === 'run_command' && DESTRUCTIVE_SHELL.test(str(a.toolArgs.command)),
  },
  {
    policy: 'pii-exfiltration',
    risk: 90,
    reason: 'Message contains PII (SSN / card number) and is addressed outside the organisation.',
    test: (a) =>
      a.toolName === 'send_email' &&
      (SSN.test(str(a.toolArgs.body)) || CARD.test(str(a.toolArgs.body))) &&
      !INTERNAL_DOMAIN.test(str(a.toolArgs.to)),
  },
  {
    policy: 'secret-write',
    risk: 85,
    reason: 'Writing credentials or secrets to a file.',
    test: (a) =>
      a.toolName === 'write_file' &&
      (AWS_KEY.test(str(a.toolArgs.contents)) || /private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY/i.test(str(a.toolArgs.contents))),
  },
  {
    policy: 'cumulative-threshold-split',
    risk: 80,
    reason:
      'Repeated sub-threshold spend to the same vendor -- cumulative total exceeds the $10,000 approval threshold.',
    test: (a, ctx) => {
      if (a.toolName !== 'create_purchase_order' && a.toolName !== 'approve_payment') return false;
      const amount = num(a.toolArgs.amount);
      if (amount >= 10_000) return false;
      return ctx.cumulative.spend + amount > 10_000;
    },
  },
  {
    policy: 'spend-over-threshold',
    risk: 75,
    reason: 'Single payment exceeds the $10,000 human-approval threshold.',
    test: (a) =>
      (a.toolName === 'approve_payment' || a.toolName === 'create_purchase_order') &&
      num(a.toolArgs.amount) >= 10_000,
  },
  {
    policy: 'bulk-data-access',
    risk: 60,
    reason: 'Repeated bulk reads of customer data in one session.',
    test: (a, ctx) =>
      (a.toolName === 'lookup_customer' || a.toolName === 'query_database') &&
      ctx.cumulative.dataAccessCount >= 5,
  },
  {
    policy: 'sensitive-field-access',
    risk: 55,
    reason: 'Request explicitly asks for sensitive fields (ssn / card number).',
    test: (a) => a.toolName === 'lookup_customer' && /ssn|card_number|social/.test(blob(a)),
  },
  {
    policy: 'external-recipient',
    risk: 45,
    reason: 'Email addressed to an external recipient.',
    test: (a) => a.toolName === 'send_email' && !INTERNAL_DOMAIN.test(str(a.toolArgs.to)) && !/example\.com$/i.test(str(a.toolArgs.to)),
  },
  {
    policy: 'large-refund',
    risk: 50,
    reason: 'Refund is large enough to warrant a human check.',
    test: (a) => a.toolName === 'issue_refund' && num(a.toolArgs.amount) >= 1000,
  },
  {
    policy: 'production-write',
    risk: 40,
    reason: 'Write to a sensitive path or a production config file.',
    test: (a) =>
      a.toolName === 'write_file' && /^(\.env|\/etc\/|.*\/prod(uction)?\/)/i.test(str(a.toolArgs.path)),
  },
  {
    policy: 'schema-mutation',
    risk: 45,
    reason: 'Schema-altering SQL.',
    test: (a) => a.toolName === 'query_database' && /\b(alter|create|grant)\b/i.test(str(a.toolArgs.sql)),
  },
];

export async function evaluateStub(
  action: AgentAction,
  context: SessionContext,
): Promise<EvalResult> {
  const startedAt = performance.now();

  let top: Rule | undefined;
  for (const rule of RULES) {
    if (rule.test(action, context) && (!top || rule.risk > top.risk)) top = rule;
  }

  const riskScore = top?.risk ?? 5;
  return {
    riskScore,
    decision: decisionForRiskScore(riskScore),
    reasoning: top?.reason ?? 'No policy matched; routine action.',
    violatedPolicy: top?.policy,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
  };
}
