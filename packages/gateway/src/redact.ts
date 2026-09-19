import { maskPii } from './rules.js';

// The audit log keeps the tool arguments so the dashboard can show what an agent tried, but never raw PII or secrets:
// SSNs/cards/phones become placeholders, emails keep only their domain, secret-looking keys are blanked, and long or huge
// values are cut. The result is a JSON string.

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_]?key|credential|authorization|private[-_]?key|cookie/i;
const MAX_STRING = 300;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;
const MAX_TOTAL = 4000;
const MAX_PREVIEW = 1800; // re-encoding the preview escapes its quotes, so it must stay well under half of MAX_TOTAL

function walk(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[too deep]';
  if (typeof v === 'string') {
    const m = maskPii(v);
    return m.length > MAX_STRING ? `${m.slice(0, MAX_STRING)}…(+${m.length - MAX_STRING} chars)` : m;
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    const s = String(v);
    const m = maskPii(s);
    return m === s ? v : m; // e.g. a card number sent as a number
  }
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).slice(0, MAX_ITEMS).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : walk(x, depth + 1)]),
    );
  }
  return v;
}

export function redactArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(walk(args, 0), (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
  return json.length > MAX_TOTAL ? JSON.stringify({ _truncated: true, preview: json.slice(0, MAX_PREVIEW) }) : json;
}
