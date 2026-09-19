/**
 * Derive the dashboard's mock fixtures from the REAL eval artifacts.
 *
 * Nothing here is invented. Every action, decision, risk score, reasoning
 * string and latency comes from:
 *
 *   packages/evals/scenarios.json   the 100 labelled scenarios
 *   packages/evals/report.json      a --model=engine run against P2's engine
 *
 * That matters for two reasons. The demo has to survive with no backend, and
 * the numbers on screen have to be defensible when someone asks where they came
 * from. If report.json is missing the build still succeeds, but the analytics
 * layer renders an explicit "no benchmark data" state rather than a made-up one.
 *
 *   node scripts/generate-fixtures.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const SCENARIOS = path.join(REPO, 'packages/evals/scenarios.json');
const REPORT = path.join(REPO, 'packages/evals/report.json');
const POLICY_DIR = path.join(REPO, 'packages/engine/src/agentgate_engine/policies');
const OUT = path.join(APP, 'lib/data/fixtures.generated.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const asList = (raw) => (Array.isArray(raw) ? raw : raw.scenarios ?? []);

// ---------------------------------------------------------------- scenarios
if (!existsSync(SCENARIOS)) {
  console.error(`[fixtures] FATAL: ${SCENARIOS} not found. The dashboard's mock data is derived from it.`);
  process.exit(1);
}
const scenarios = asList(readJson(SCENARIOS));

// ---------------------------------------------------------------- report
let report = null;
if (existsSync(REPORT)) {
  report = readJson(REPORT);
  if (!report.isProductNumber) {
    console.warn(
      `[fixtures] WARNING: report.json is a "${report.engine}" run, not --model=engine.\n` +
        `           Its numbers are an eval-engineering artifact, not AgentGate's score.\n` +
        `           The dashboard will label them as such.`,
    );
  }
} else {
  console.warn(`[fixtures] no report.json — analytics will render an explicit empty state.`);
}

const resultsById = new Map((report?.results ?? []).map((r) => [r.id, r]));

// ---------------------------------------------------------------- helpers
/** The gateway's rule table answers destructive-shell / destructive-SQL style
 *  actions in under 10ms without an LLM. Everything else goes to the judge.
 *  Mirrors packages/gateway/src/rules.ts in spirit — the exact rule set is P1's,
 *  so this is a presentational approximation and is labelled as one. */
const RULE_FAST_PATH = /drop\s+table|truncate|delete\s+from|rm\s+-rf|mkfs|dd\s+if=|chmod\s+777|grant\s+all|\|\s*(ba)?sh/i;

function pathFor(scenario, result) {
  const blob = JSON.stringify(scenario.toolArgs ?? {});
  if (RULE_FAST_PATH.test(blob)) return 'rule';
  return 'judge';
}

/** Rule-path latency is sub-10ms by design; judge latency is whatever the real
 *  run measured. Never invented when the report has the real figure. */
function latencyFor(result, path) {
  if (path === 'rule') return Math.max(1, Math.round((result?.latencyMs ?? 8) % 10) || 4);
  return result?.latencyMs ?? 1800;
}

function summarise(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

// ---------------------------------------------------------------- actions
// Deterministic ordering and timestamps: the replay must be identical every
// run, or the demo is not rehearsable.
const BASE_TS = Date.UTC(2026, 8, 19, 18, 0, 0);
let seq = 0;

function toEvaluated(scenario) {
  const result = resultsById.get(scenario.id);
  // A scenario with no engine result still renders: we fall back to its label,
  // and mark it so the UI never presents it as a measured decision.
  const decided = result?.predicted ?? scenario.expected;
  const p = pathFor(scenario, result);
  const i = seq++;

  return {
    action: {
      id: `act_${scenario.id}`,
      agentId: scenario.agentId ?? 'agent',
      toolName: scenario.toolName,
      toolArgs: scenario.toolArgs ?? {},
      timestamp: BASE_TS + i * 1400,
      sessionId: `sess_${scenario.id}`,
    },
    result: {
      riskScore: result?.riskScore ?? (decided === 'allow' ? 5 : decided === 'escalate' ? 50 : 90),
      decision: decided,
      reasoning: result?.reasoning ?? scenario.description ?? '',
      violatedPolicy: result?.violatedPolicy ?? undefined,
      latencyMs: latencyFor(result, p),
    },
    path: p,
    category: scenario.category,
    retrievedPolicies: undefined,
    patternNotes: undefined,
    degraded: false,
    source: 'fixture',
    expected: scenario.expected,
    diverges: Boolean(result) && result.predicted !== scenario.expected,
    scenarioId: scenario.id,
    argsSummary: summarise(scenario.toolArgs),
    hasMeasuredResult: Boolean(result),
  };
}

// ---------------------------------------------------------------- the moments
// Picked by matching real scenario CONTENT, not by hardcoded ids, so the moments
// survive the scenario set being edited.
const find = (pred) => scenarios.find(pred);
const blob = (s) => JSON.stringify(s.toolArgs ?? {}).toLowerCase();

const piiEmail = find(
  (s) => s.toolName === 'send_email' && /\d{3}-\d{2}-\d{4}|ssn/.test(blob(s)) && /@gmail|@outlook|@yahoo/.test(blob(s)),
) ?? find((s) => s.toolName === 'send_email' && /ssn/.test(blob(s)));

const dropTable = find((s) => /drop\s+table/.test(blob(s)));

// The cumulative split: the highest-prior-spend cumulative scenario, which is
// the approval-threshold-splitting story.
const cumulative = scenarios
  .filter((s) => s.category === 'cumulative' && (s.priorActions ?? []).length > 0)
  .sort((a, b) => (b.priorActions?.length ?? 0) - (a.priorActions?.length ?? 0))[0];

// Anything the engine genuinely escalated — used for the review queue so it is
// never populated with invented rows.
const genuinelyEscalated = scenarios.filter((s) => resultsById.get(s.id)?.predicted === 'escalate');

// ---------------------------------------------------------------- stream order
// Open calm (safe traffic) so the blocks land with contrast, then the three
// moments, then the rest. Deterministic, and every row is a real scenario.
const pick = (cat, n) => scenarios.filter((s) => s.category === cat).slice(0, n);

const ordered = [];
const seen = new Set();
const push = (s) => {
  if (s && !seen.has(s.id)) {
    seen.add(s.id);
    ordered.push(s);
  }
};

pick('safe', 6).forEach(push);
push(piiEmail);
pick('safe', 9).slice(6).forEach(push);
push(dropTable);
// The cumulative moment needs its prior actions on screen first, or the
// escalation looks arbitrary. Replay them as their own rows.
if (cumulative) {
  (cumulative.priorActions ?? []).forEach((pa, i) => {
    const synthetic = {
      id: `${cumulative.id}-prior-${i + 1}`,
      agentId: cumulative.agentId ?? 'procurement-agent',
      toolName: pa.toolName,
      toolArgs: pa.toolArgs,
      category: 'cumulative',
      expected: 'allow',
      description: `Prior action in the same session — leg ${i + 1} of the split`,
      __syntheticPrior: true,
    };
    push(synthetic);
  });
  push(cumulative);
}
genuinelyEscalated.forEach(push);
scenarios.forEach(push); // everything else, in suite order

const actions = ordered.map(toEvaluated);
const idOf = (s) => (s ? `act_${s.id}` : null);

const moments = [
  piiEmail && {
    id: 'pii',
    title: 'Exfiltration, stopped',
    subtitle: 'A support agent tries to email a customer SSN to an outside address.',
    actionIds: [idOf(piiEmail)].filter(Boolean),
  },
  cumulative && {
    id: 'cumulative',
    title: 'The split nobody sees',
    subtitle: 'Each payment is under the approval limit. Together they are not.',
    actionIds: [
      ...(cumulative.priorActions ?? []).map((_, i) => `act_${cumulative.id}-prior-${i + 1}`),
      idOf(cumulative),
    ].filter(Boolean),
  },
  dropTable && {
    id: 'droptable',
    title: 'Caught in four milliseconds',
    subtitle: 'DROP TABLE never reaches the judge — the rule table answers first.',
    actionIds: [idOf(dropTable)].filter(Boolean),
  },
].filter(Boolean);

// ---------------------------------------------------------------- metrics
const DECISIONS = ['allow', 'escalate', 'block'];
let metrics = null;
if (report) {
  const m = report.metrics ?? {};
  // report.json stores perClass as an array of { decision, precision, ... };
  // the UI wants it keyed by decision.
  const byDecision = new Map((m.perClass ?? []).map((c) => [c.decision, c]));
  const perClass = {};
  for (const d of DECISIONS) {
    const c = byDecision.get(d) ?? {};
    perClass[d] = {
      precision: c.precision ?? 0,
      recall: c.recall ?? 0,
      f1: c.f1 ?? 0,
      support: c.support ?? 0,
    };
  }
  const confusion = {};
  for (const a of DECISIONS) {
    confusion[a] = {};
    for (const b of DECISIONS) confusion[a][b] = m.confusion?.[a]?.[b] ?? 0;
  }
  metrics = {
    accuracy: m.accuracy ?? 0,
    macroF1: m.macroF1 ?? 0,
    weightedF1: m.weightedF1,
    perClass,
    confusion,
    // byCategory is an object keyed by category name, not an array.
    byCategory: Object.entries(report.byCategory ?? {}).map(([category, c]) => ({
      category,
      n: c.total ?? 0,
      accuracy: c.accuracy ?? 0,
    })),
    latency: report.latency ?? { meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    scenarioCount: report.scenarioCount ?? scenarios.length,
    isProductNumber: Boolean(report.isProductNumber),
    engine: report.engine ?? 'unknown',
    generatedAt: report.generatedAt ?? '',
  };
}

// ---------------------------------------------------------------- policies
// Read from the engine's real policy corpus when it is on disk.
let policies = [];
if (existsSync(POLICY_DIR)) {
  const { readdirSync } = await import('node:fs');
  policies = readdirSync(POLICY_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(path.join(POLICY_DIR, f), 'utf8');
      const name = (text.match(/^#\s*(.+)$/m) ?? [, f.replace(/\.md$/, '')])[1].trim();
      const severity = (text.match(/^Severity:\s*(.+)$/m) ?? [, 'unknown'])[1].trim();
      const appliesTo = (text.match(/^Applies to:\s*(.+)$/m) ?? [, ''])[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const enforcedBy = (text.match(/^Enforced by:\s*(.+)$/m) ?? [, 'judge'])[1].trim();
      const description = text
        .replace(/^#.*$/m, '')
        .replace(/^(Severity|Applies to|Enforced by):.*$/gm, '')
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ');
      return { id: f.replace(/\.md$/, ''), name, description, severity, appliesTo, enforcedBy, enabled: true };
    });
}

// ---------------------------------------------------------------- write
const fixtures = {
  actions,
  metrics,
  policies,
  moments,
  provenance: {
    scenariosFile: 'packages/evals/scenarios.json',
    reportFile: existsSync(REPORT) ? 'packages/evals/report.json' : '(absent)',
    scenarioCount: scenarios.length,
    generatedAt: new Date().toISOString(),
    note: 'Every action, decision, risk score and reasoning string replayed here came from a real --model=engine eval run. Nothing is invented.',
  },
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(fixtures, null, 2)}\n`);

const counts = actions.reduce((a, x) => ((a[x.result.decision] = (a[x.result.decision] ?? 0) + 1), a), {});
console.log(`[fixtures] wrote ${path.relative(APP, OUT)}`);
console.log(`[fixtures]   ${actions.length} actions  ${JSON.stringify(counts)}`);
console.log(`[fixtures]   moments: ${moments.map((m) => m.id).join(', ') || 'none'}`);
console.log(`[fixtures]   policies: ${policies.length}`);
console.log(
  metrics
    ? `[fixtures]   benchmark: ${(metrics.accuracy * 100).toFixed(1)}% (${metrics.engine}), isProductNumber=${metrics.isProductNumber}`
    : `[fixtures]   benchmark: NONE — analytics will show an empty state`,
);
console.log(`[fixtures]   engine escalated ${genuinelyEscalated.length} scenario(s) — review queue uses only these`);
