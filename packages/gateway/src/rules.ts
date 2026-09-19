import type { AgentAction } from '@agentgate/shared';

// Fast, dumb, no-AI rules. Each rule looks at one tool call and returns { matched, riskScore, reason }.
// Reasons name the field that tripped a rule, never the sensitive value itself.

export interface RuleResult {
  matched: boolean;
  riskScore: number; // 0-100
  reason: string;
}

export interface Rule {
  name: string;
  check(action: AgentAction): RuleResult;
}

export interface RulesConfig {
  /** Tool names an agent can never call. `*` is a wildcard, matching is case-insensitive. */
  blockedTools: string[];
  /** Payment tools with an amount above this are blocked. */
  spendLimit: number;
  /** More than `maxCalls` calls from one agent inside `windowMs` are throttled. */
  rateLimit: { maxCalls: number; windowMs: number };
  /** Tools whose string arguments are checked for destructive shell/SQL. */
  shellSqlToolPattern: RegExp;
  /** Tools whose amount arguments are checked against the spending limit. */
  paymentToolPattern: RegExp;
}

export const DEFAULT_CONFIG: RulesConfig = {
  blockedTools: [],
  spendLimit: 500,
  rateLimit: { maxCalls: 20, windowMs: 60_000 },
  shellSqlToolPattern: /shell|bash|exec|command|cmd|terminal|sql|query|database/i,
  paymentToolPattern: /pay|refund|purchase|charge|transfer|checkout|invoice|billing/i,
};

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Reads AGENTGATE_BLOCKED_TOOLS (comma-separated), AGENTGATE_SPEND_LIMIT, AGENTGATE_RATE_LIMIT, AGENTGATE_RATE_WINDOW_MS. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RulesConfig {
  return {
    ...DEFAULT_CONFIG,
    blockedTools: (env.AGENTGATE_BLOCKED_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    spendLimit: positive(env.AGENTGATE_SPEND_LIMIT, DEFAULT_CONFIG.spendLimit),
    rateLimit: {
      maxCalls: positive(env.AGENTGATE_RATE_LIMIT, DEFAULT_CONFIG.rateLimit.maxCalls),
      windowMs: positive(env.AGENTGATE_RATE_WINDOW_MS, DEFAULT_CONFIG.rateLimit.windowMs),
    },
  };
}

const NO_MATCH: RuleResult = { matched: false, riskScore: 0, reason: '' };
const hit = (riskScore: number, reason: string): RuleResult => ({ matched: true, riskScore, reason });

// --- Argument walking -------------------------------------------------------

interface Field {
  path: string; // e.g. "items[0].note"
  key: string; // nearest object key, e.g. "note"
  value: unknown;
}

function collectFields(value: unknown, path = '', key = '', out: Field[] = [], depth = 0): Field[] {
  if (depth > 10) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectFields(v, `${path}[${i}]`, key, out, depth + 1));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectFields(v, path ? `${path}.${k}` : k, k, out, depth + 1);
  } else if (value !== null && value !== undefined) {
    out.push({ path: path || '(root)', key, value });
  }
  return out;
}

const asText = (f: Field): string | undefined =>
  typeof f.value === 'string' ? f.value : typeof f.value === 'number' || typeof f.value === 'bigint' ? String(f.value) : undefined;

// --- 1. PII detector --------------------------------------------------------

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const SSN = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const CARD = /\b\d(?:[ -]?\d){14,15}\b/g; // 15-16 digits (Amex, Visa, Mastercard, ...)
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;

// Emails and phone numbers are normal in address-style fields ("to", "phone"), so only flag them elsewhere
// (e.g. inside an email body). SSNs and card numbers are flagged in every field.
const EMAIL_FIELDS = /^(to|cc|bcc|from|sender|reply_?to|recipients?|e-?mail(_?address)?)$/i;
const PHONE_FIELDS = /^(phone(_?number)?|tel(ephone)?|mobile|cell)$/i;

const validSsn = (m: RegExpMatchArray) =>
  m[1] !== '000' && m[1] !== '666' && m[1][0] !== '9' && m[2] !== '00' && m[3] !== '0000';

const piiDetector: Rule = {
  name: 'pii_detector',
  check(action) {
    const found = new Map<string, number>(); // "kind in path" -> score
    const add = (kind: string, score: number, path: string) => found.set(`${kind} in "${path}"`, score);

    for (const f of collectFields(action.toolArgs)) {
      const text = asText(f);
      if (!text) continue;
      for (const m of text.matchAll(SSN)) if (validSsn(m)) add('SSN', 95, f.path);
      for (const m of text.matchAll(CARD)) {
        const digits = m[0].replace(/\D/g, '');
        if (/^[2-6]/.test(digits) && luhnValid(digits)) add('credit card number', 95, f.path);
      }
      if (!EMAIL_FIELDS.test(f.key) && text.match(EMAIL)) add('email address', 40, f.path);
      if (!PHONE_FIELDS.test(f.key) && text.match(PHONE)) add('phone number', 40, f.path);
    }
    if (found.size === 0) return NO_MATCH;
    return hit(Math.max(...found.values()), `PII detected: ${[...found.keys()].join(', ')}`);
  },
};

// --- 2. Destructive command blocker ----------------------------------------

const DESTRUCTIVE: { name: string; re: RegExp; score: number }[] = [
  { name: 'recursive rm', re: /\brm\s+(?:\S+\s+)*?-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b/, score: 95 },
  { name: 'rm --no-preserve-root', re: /--no-preserve-root/, score: 100 },
  { name: 'DROP TABLE/DATABASE/SCHEMA', re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, score: 95 },
  { name: 'TRUNCATE', re: /\bTRUNCATE\b/i, score: 95 },
  // "FORMAT" on its own is far too common a word; match the disk-wiping forms.
  { name: 'disk format', re: /\bformat\s+[a-z]:|\bmkfs(?:\.\w+)?\b|\bdiskutil\s+erase/i, score: 95 },
  { name: 'dd to a device', re: /\bdd\s+[^;|&]*\bof=\/dev\//, score: 95 },
];

const destructiveCommands = (config: RulesConfig): Rule => ({
  name: 'destructive_command',
  check(action) {
    if (!config.shellSqlToolPattern.test(action.toolName)) return NO_MATCH;
    const found = new Map<string, number>();
    for (const f of collectFields(action.toolArgs)) {
      if (typeof f.value !== 'string') continue;
      for (const d of DESTRUCTIVE) if (d.re.test(f.value)) found.set(`${d.name} in "${f.path}"`, d.score);
      for (const m of f.value.matchAll(/\bDELETE\s+FROM\b[^;]*/gi)) {
        // A bare DELETE wipes the whole table; one with a WHERE is riskier than a read but still targeted.
        if (/\bWHERE\b/i.test(m[0])) found.set(`DELETE FROM with WHERE in "${f.path}"`, 50);
        else found.set(`DELETE FROM without WHERE in "${f.path}"`, 95);
      }
    }
    if (found.size === 0) return NO_MATCH;
    return hit(Math.max(...found.values()), `destructive command: ${[...found.keys()].join(', ')}`);
  },
});

// --- 3. Spending limit ------------------------------------------------------

const AMOUNT_KEY = /amount|total|price|cost/i;

const parseAmount = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const n = Number(v.replace(/[^0-9.-]/g, ''));
  return v.match(/\d/) && Number.isFinite(n) ? n : undefined;
};

const spendingLimit = (config: RulesConfig): Rule => ({
  name: 'spending_limit',
  check(action) {
    if (!config.paymentToolPattern.test(action.toolName)) return NO_MATCH;
    let worst: { amount: number; path: string } | undefined;
    for (const f of collectFields(action.toolArgs)) {
      if (!AMOUNT_KEY.test(f.key)) continue;
      const amount = parseAmount(f.value);
      if (amount !== undefined && amount > config.spendLimit && (!worst || amount > worst.amount)) worst = { amount, path: f.path };
    }
    return worst ? hit(90, `spending limit exceeded: "${worst.path}" is ${worst.amount}, limit is ${config.spendLimit}`) : NO_MATCH;
  },
});

// --- 4. Rate limiter --------------------------------------------------------

// Stateful: keeps recent call times per agent, so each engine gets its own instance.
const rateLimiter = (config: RulesConfig): Rule => {
  const { maxCalls, windowMs } = config.rateLimit;
  const calls = new Map<string, number[]>();
  return {
    name: 'rate_limit',
    check(action) {
      const now = action.timestamp.getTime();
      const recent = (calls.get(action.agentId) ?? []).filter((t) => now - t < windowMs);
      recent.push(now); // blocked attempts count too
      calls.set(action.agentId, recent);
      return recent.length > maxCalls
        ? hit(75, `rate limit exceeded: ${recent.length} calls in ${windowMs / 1000}s (max ${maxCalls})`)
        : NO_MATCH;
    },
  };
};

// --- 5. Blocked tool list ---------------------------------------------------

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

const blockedTools = (config: RulesConfig): Rule => {
  const patterns = config.blockedTools.map(globToRegExp);
  return {
    name: 'blocked_tool',
    check: (action) => (patterns.some((p) => p.test(action.toolName)) ? hit(100, `tool "${action.toolName}" is on the blocked list`) : NO_MATCH),
  };
};

// --- Engine -----------------------------------------------------------------

export interface EngineResult {
  matched: boolean;
  /** Highest risk score among matched rules. */
  riskScore: number;
  /** Reasons of every matched rule, joined. */
  reason: string;
  /** Names of every matched rule. */
  rules: string[];
}

/**
 * Runs every enabled rule (not just until the first hit, so the rate limiter always sees the call).
 * `isEnabled` lets the policies table switch individual rules off.
 */
export function createRuleEngine(config: RulesConfig = DEFAULT_CONFIG, isEnabled: (ruleName: string) => boolean = () => true) {
  const rules: Rule[] = [blockedTools(config), piiDetector, destructiveCommands(config), spendingLimit(config), rateLimiter(config)];
  return {
    rules,
    run(action: AgentAction): EngineResult {
      const matches = rules
        .filter((r) => isEnabled(r.name))
        .map((r) => ({ name: r.name, result: r.check(action) }))
        .filter((m) => m.result.matched);
      return {
        matched: matches.length > 0,
        riskScore: Math.max(0, ...matches.map((m) => m.result.riskScore)),
        reason: matches.map((m) => m.result.reason).join('; '),
        rules: matches.map((m) => m.name),
      };
    },
  };
}
