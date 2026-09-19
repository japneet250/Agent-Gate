import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Decision } from './data/types';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const DECISION_LABEL: Record<Decision, string> = {
  allow: 'Allowed',
  block: 'Blocked',
  escalate: 'Escalated',
};

/** Colour is the fastest signal in the room; keep it consistent everywhere. */
export const decisionClasses = (d: Decision) =>
  ({
    allow: { rail: 'rail-allow', tint: 'tint-allow', text: 'text-allow', bg: 'bg-allow', border: 'border-allow/40' },
    block: { rail: 'rail-block', tint: 'tint-block', text: 'text-block', bg: 'bg-block', border: 'border-block/40' },
    escalate: {
      rail: 'rail-escalate',
      tint: 'tint-escalate',
      text: 'text-escalate',
      bg: 'bg-escalate',
      border: 'border-escalate/40',
    },
  })[d];

export function formatLatency(ms: number) {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}

/** A readable one-line digest of tool args. Keys first — the argument NAMES are
 *  often the story ("ssn", "card_number") even when values are redacted. */
export function summariseArgs(args: Record<string, unknown>, max = 92): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    const val =
      typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    parts.push(`${k}=${val}`);
  }
  const joined = parts.join('  ');
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

/** Pull out the bit of a value that makes a demo audience gasp. */
const SIGNALS: { re: RegExp; label: string }[] = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN' },
  { re: /\b(?:\d[ -]?){13,16}\b/, label: 'card number' },
  { re: /drop\s+table|truncate|delete\s+from/i, label: 'destructive SQL' },
  { re: /rm\s+-rf/i, label: 'recursive delete' },
  { re: /@(gmail|outlook|yahoo|hotmail|proton)\./i, label: 'external address' },
  { re: /\b(sk-[a-z0-9-]{8,}|aws_secret|api[_-]?key|password)\b/i, label: 'credential' },
  { re: /grant\s+all/i, label: 'privilege grant' },
];

export function signalsIn(args: Record<string, unknown>): string[] {
  const blob = JSON.stringify(args ?? {});
  return SIGNALS.filter((s) => s.re.test(blob)).map((s) => s.label);
}
