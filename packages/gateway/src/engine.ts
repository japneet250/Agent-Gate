import type { AgentAction } from '@agentgate/shared';
import { decide, type Evaluator, type Verdict } from './evaluate.js';
import { log } from './log.js';
import { reportError } from './monitoring.js';

// Client for Person 2's AI judge (a Python FastAPI service; see packages/engine/INTEGRATION.md on their branch).
// It only sees calls that no rule caught, so anything the rules block (SSNs, cards, ...) never leaves the gateway.
//
// Request (flat, camelCase), with `Authorization: Bearer <key>` if the engine requires one:
//   POST <AGENTGATE_ENGINE_URL>   { agentId, toolName, toolArgs, sessionId }
// The engine keeps per-session history (cumulative spend, repeated calls...), keyed by sessionId, so a stable sessionId
// per agent conversation matters: a fresh one per call silently disables cumulative detection.
// Response: an EvalResult (riskScore, decision, reasoning, violatedPolicy, latencyMs) plus extras for the dashboard
// (category, retrievedPolicies, patternNotes, guardrails, degraded), which we keep. snake_case names are accepted too.

export interface EngineJudgeOptions {
  /** The engine's evaluate URL. `https://host` and `https://host/evaluate` both work. */
  url: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Never logged. */
  apiKey?: string;
  /** Give up after this long (default 30000ms). The engine's own judge timeout is 25s; cutting in earlier turns a good decision into an escalation. */
  timeoutMs?: number;
  /** What to answer when the judge is unreachable or replies with nonsense. Default 'escalate' (blocks for now). */
  onError?: Verdict['decision'];
  fetch?: typeof fetch;
}

const DECISIONS = ['allow', 'block', 'escalate'] as const;
const ERROR_SCORE = { allow: 0, escalate: 50, block: 90 } as const;

const pick = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);

/** Reads the engine's reply into a Verdict, or undefined if it isn't usable. */
export function parseEngineResult(body: unknown, roundTripMs: number): Verdict | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;

  const score = pick(b, 'riskScore', 'risk_score');
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return undefined;

  const rawDecision = pick(b, 'decision');
  const decision = rawDecision === undefined ? decide(score) : DECISIONS.find((d) => d === rawDecision);
  if (!decision) return undefined;

  // The engine sets `degraded: true` when a node fell back instead of using its model: trust the score less.
  const degraded = b.degraded === true;
  const reasoning = pick(b, 'reasoning');
  const policy = pick(b, 'violatedPolicy', 'violated_policy');
  const latency = pick(b, 'latencyMs', 'latency_ms');
  const category = pick(b, 'category');
  const list = (v: unknown) => (Array.isArray(v) ? v : undefined);
  // The engine sends `zipFacts` as sentences, or null when Zip was not consulted. Keep only real strings.
  const zipRaw = list(pick(b, 'zipFacts', 'zip_facts'));
  const zipFacts = zipRaw?.filter((f): f is string => typeof f === 'string' && f.length > 0);
  return {
    riskScore: score,
    decision,
    reasoning: `${degraded ? '[degraded] ' : ''}${typeof reasoning === 'string' && reasoning ? reasoning : 'AI judge gave no reasoning'}`,
    ...(typeof policy === 'string' && policy ? { violatedPolicy: policy } : {}),
    latencyMs: typeof latency === 'number' && Number.isFinite(latency) ? latency : Math.round(roundTripMs * 100) / 100,
    ...(typeof category === 'string' ? { category } : {}),
    retrievedPolicies: list(pick(b, 'retrievedPolicies', 'retrieved_policies')),
    patternNotes: list(pick(b, 'patternNotes', 'pattern_notes')),
    guardrails: list(b.guardrails),
    ...(zipFacts && zipFacts.length > 0 ? { zipFacts } : {}),
    degraded,
    decidedBy: 'judge',
  };
}

export function createEngineJudge(opts: EngineJudgeOptions): Evaluator {
  const base = opts.url.replace(/\/+$/, '');
  const endpoint = /\/evaluate$/.test(base) ? base : `${base}/evaluate`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const onError = opts.onError ?? 'escalate';
  const doFetch = opts.fetch ?? fetch;

  // Fail closed: if the judge can't answer, the call gets `onError` (escalate by default, which blocks).
  const unavailable = (cause: string, start: number): Verdict => {
    log(`AI judge unavailable (${cause}), answering "${onError}"`);
    reportError(new Error(`AI judge unavailable: ${cause}`), 'judge');
    return {
      riskScore: ERROR_SCORE[onError],
      decision: onError,
      reasoning: `AI judge unavailable (${cause}); defaulting to ${onError}`,
      violatedPolicy: 'judge_unavailable',
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
      degraded: true,
      decidedBy: 'fallback',
    };
  };

  return async (action: AgentAction) => {
    const start = performance.now();
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({ agentId: action.agentId, toolName: action.toolName, toolArgs: action.toolArgs, sessionId: action.sessionId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return unavailable(timedOut ? `timed out after ${timeoutMs}ms` : 'unreachable', start);
    }
    if (!res.ok) return unavailable(`HTTP ${res.status}`, start);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return unavailable('reply was not JSON', start);
    }
    return parseEngineResult(body, performance.now() - start) ?? unavailable('reply was not a valid result', start);
  };
}

/**
 * Builds the judge from env vars, or returns undefined if no engine URL is set (then unmatched calls are just allowed).
 *   AGENTGATE_ENGINE_URL   (ENGINE_URL also accepted)   AGENTGATE_ENGINE_KEY
 *   AGENTGATE_JUDGE_TIMEOUT_MS   AGENTGATE_JUDGE_ON_ERROR (allow|escalate|block)
 */
export function judgeFromEnv(env: Record<string, string | undefined> = process.env): Evaluator | undefined {
  const url = env.AGENTGATE_ENGINE_URL || env.ENGINE_URL;
  if (!url) return undefined;
  const timeout = Number(env.AGENTGATE_JUDGE_TIMEOUT_MS);
  const onError = DECISIONS.find((d) => d === env.AGENTGATE_JUDGE_ON_ERROR);
  return createEngineJudge({
    url,
    ...(env.AGENTGATE_ENGINE_KEY ? { apiKey: env.AGENTGATE_ENGINE_KEY } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...(onError ? { onError } : {}),
  });
}
