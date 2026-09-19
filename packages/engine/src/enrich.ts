/**
 * Query enrichment for retrieval.
 *
 * A raw payload shares no vocabulary with policy prose: "123-45-6789" has no
 * token in common with "personally identifiable information". Naming the entity
 * types we can detect gives both the dense and sparse retrievers something to
 * match on, so the right policy surfaces for the payload that actually violates
 * it. This is a retrieval aid only — it makes no decision and blocks nothing.
 */

const DETECTORS: { label: string; test: RegExp }[] = [
  { label: 'social security number SSN personally identifiable information', test: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: 'credit card payment card number personally identifiable information', test: /\b(?:\d[ -]?){13,16}\b/ },
  { label: 'date of birth personally identifiable information', test: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\bdob\b|\bdate of birth\b|\bborn\b/i },
  { label: 'email address contact detail', test: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { label: 'home address personally identifiable information', test: /\b\d+\s+[A-Za-z]+\s+(street|st|road|rd|avenue|ave|drive|dr|lane|ln)\b/i },
  { label: 'API key secret credential token password', test: /\b(api[_-]?key|secret|password|token|bearer|sk-[a-z0-9-]{8,})\b/i },
  { label: 'destructive SQL statement schema change', test: /\b(drop\s+table|truncate|alter\s+table|delete\s+from|update\s+\w+\s+set)\b/i },
  { label: 'destructive shell command file deletion', test: /\b(rm\s+-rf|mkfs|dd\s+if=|chmod\s+777|curl[^|]*\|\s*(ba)?sh)\b/i },
  { label: 'bulk export of many records', test: /\b(limit\s*[:=]?\s*\d{3,}|select\s+\*|export|dump|all\s+records)\b/i },
  { label: 'privilege escalation permission grant admin role', test: /\b(grant|admin|superuser|sudo|root|iam|privilege|role)\b/i },
  { label: 'money payment amount transaction', test: /\b(amount|total|price|cost|usd|\$\s?\d)/i },
  { label: 'instruction injection embedded in data', test: /\b(ignore (all )?(previous|prior) instructions?|disregard the above|you must (now )?(set|approve))\b/i },
];

/** Append descriptions of whatever sensitive shapes appear in the action. */
export function enrichQuery(baseQuery: string, payload: string): string {
  const found = DETECTORS.filter((d) => d.test.test(payload)).map((d) => d.label);
  if (found.length === 0) return baseQuery;
  return `${baseQuery}\nDetected in the payload: ${found.join('; ')}.`;
}

/** Exposed for tests and for the dashboard's "why was this retrieved" view. */
export function detectEntities(payload: string): string[] {
  return DETECTORS.filter((d) => d.test.test(payload)).map((d) => d.label);
}
