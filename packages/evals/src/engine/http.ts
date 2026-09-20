/**
 * HTTP client for P2's engine.
 *
 * P2 ported the engine to Python + FastAPI (commit ebd229d, a declared breaking
 * change), so `@agentgate/engine` is not an importable module and never will be.
 * It is a service:
 *
 *   cd packages/engine && ./setup.sh && ./venv/bin/uvicorn server:app --port 8000
 *
 * This module is the seam. Everything above it -- the harness, the demo agents,
 * the regression gate -- still sees a plain `evaluate(action, context)`.
 *
 * Contract source: packages/engine/INTEGRATION.md.
 */

import type { AgentAction, Decision, EvalResult, SessionContext } from '@agentgate/shared-types';
import { JudgeInvalidOutput, withRetry, type RetryOptions, DEFAULT_RETRY } from '../models/errors.js';

export type EngineHttpOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  /** Shared secret; defaults to AGENTGATE_API_KEY. */
  apiKey?: string;
  /** Replay a scenario's priorActions through the engine first. See replay note below. */
  replayPriorActions?: boolean;
  retry?: RetryOptions;
};

/**
 * Shared secret for the engine's HTTP API (P2, commit a93cd8c). Empty means the
 * engine is open, which is correct on localhost and wrong the moment it is
 * tunnelled for the demo -- an open endpoint lets anyone spend our OpenAI
 * credit. When set, every engine call must carry `Authorization: Bearer <key>`.
 */
export function engineApiKey(): string | undefined {
  return process.env.AGENTGATE_API_KEY || undefined;
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function engineBaseUrl(): string {
  return (process.env.AGENTGATE_ENGINE_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
}

/**
 * P2 measured mean 1842ms / p95 2740ms, and the engine's own judge timeout is
 * 25s. INTEGRATION.md is explicit that cutting the client timeout below that
 * turns a good decision into a needless escalation, so default above it.
 */
export function engineTimeoutMs(): number {
  const raw = Number(process.env.AGENTGATE_ENGINE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** Extra detail the engine returns beyond the shared EvalResult. */
export type EngineDetail = {
  category?: string;
  retrievedPolicies?: { name: string; score: number }[];
  patternNotes?: string[];
  guardrails?: { rule: string; detail: string }[];
  degraded?: boolean;
};

/**
 * `degraded: true` means a node fell back instead of using its model. A suite
 * with degraded evaluations measured a crippled engine, not the product, so the
 * count is tracked and surfaced rather than quietly averaged in.
 */
let degradedCount = 0;
export const engineDegradedCount = (): number => degradedCount;
export const resetEngineDegradedCount = (): void => {
  degradedCount = 0;
};

const DECISIONS: readonly Decision[] = ['allow', 'block', 'escalate'];

/**
 * Our AgentAction.timestamp is a number (epoch ms); P2's is a `datetime`.
 * Serialise to ISO rather than relying on pydantic's seconds-vs-milliseconds
 * heuristic for bare integers -- that heuristic is the kind of thing that
 * silently changes between library versions.
 */
function toWireAction(action: AgentAction): Record<string, unknown> {
  return {
    id: action.id,
    agentId: action.agentId,
    toolName: action.toolName,
    toolArgs: action.toolArgs,
    timestamp: new Date(action.timestamp).toISOString(),
    sessionId: action.sessionId,
  };
}

/**
 * P2's SessionContext has no `cumulative` -- the engine owns cumulative state in
 * its own session store. Dropping it here rather than sending a field the engine
 * ignores, so the wire says what is actually true.
 */
function toWireContext(context: SessionContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return {
    sessionId: context.sessionId,
    recentActions: (context.recentActions ?? []).map(toWireAction),
  };
}

class EngineHttpError extends Error {
  readonly status: number;
  readonly headers: Headers;
  constructor(status: number, statusText: string, body: string, headers: Headers) {
    super(`engine returned ${status} ${statusText}: ${body.slice(0, 300)}`);
    this.name = 'EngineHttpError';
    this.status = status;
    this.headers = headers;
  }
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new EngineHttpError(res.status, res.statusText, await res.text().catch(() => ''), res.headers);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** The engine's judgement is only usable if it conforms. Non-conformance is a
 *  plumbing failure, so it raises JudgeInvalidOutput and buckets as `invalid`
 *  rather than being scored as a wrong decision. */
function parseResult(payload: Record<string, unknown>, latencyMs: number): EvalResult {
  const decision = payload.decision;
  if (typeof decision !== 'string' || !DECISIONS.includes(decision as Decision)) {
    throw new JudgeInvalidOutput(
      `engine returned decision=${JSON.stringify(decision)}, expected one of ${DECISIONS.join('|')}`,
      JSON.stringify(payload).slice(0, 500),
    );
  }

  const riskScore = Number(payload.riskScore);
  if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    throw new JudgeInvalidOutput(
      `engine returned riskScore=${JSON.stringify(payload.riskScore)}, expected 0-100`,
      JSON.stringify(payload).slice(0, 500),
    );
  }

  if (payload.degraded === true) degradedCount += 1;

  return {
    riskScore,
    decision: decision as Decision,
    reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : '',
    violatedPolicy: typeof payload.violatedPolicy === 'string' ? payload.violatedPolicy : undefined,
    // The engine reports its own internal latency; we report what a caller
    // actually waits, which is the number the gateway has to budget for.
    latencyMs,
  };
}

/**
 * Build an `evaluate(action, context)` backed by the HTTP engine.
 *
 * **Replay.** The engine's pattern detector reads cumulative spend and access
 * counts from its own session store only -- `context.recentActions` reaches the
 * judge as narrative, but never reaches the pattern detector (see
 * engine.py: `session_facts` is built from `session_store()` alone). Our 10
 * cumulative scenarios encode their history as `priorActions`, so sending them
 * as context alone would have the engine see `total_spend = 0`, never fire the
 * cumulative alert, and score 10 wrong answers that are our harness's fault and
 * not the engine's.
 *
 * So we replay each prior action through `/evaluate` first, on the same
 * sessionId, before the scored call. That is also what genuinely happens in a
 * real session. It costs 28 extra evaluations across the whole suite.
 *
 * Replayed results are discarded and never scored. Set
 * `AGENTGATE_ENGINE_REPLAY=0` to skip it -- cheaper, but the cumulative
 * category becomes meaningless, so the harness says so rather than reporting
 * the number as if it held.
 */
export function createEngineEvaluate(options: EngineHttpOptions = {}) {
  const baseUrl = options.baseUrl ?? engineBaseUrl();
  const timeoutMs = options.timeoutMs ?? engineTimeoutMs();
  const retry = options.retry ?? DEFAULT_RETRY;
  const apiKey = options.apiKey ?? engineApiKey();
  const replay = options.replayPriorActions ?? process.env.AGENTGATE_ENGINE_REPLAY !== '0';
  const url = `${baseUrl}/evaluate`;

  return async function evaluate(
    action: AgentAction,
    context: SessionContext,
  ): Promise<EvalResult> {
    if (replay) {
      for (const prior of context?.recentActions ?? []) {
        // No context: the engine falls back to the history it recorded itself,
        // which is exactly the state we are trying to build up.
        await withRetry(
          () => postJson(url, { action: toWireAction(prior) }, timeoutMs, apiKey),
          retry,
        );
      }
    }

    const startedAt = performance.now();
    const payload = await withRetry(
      () =>
        postJson(
          url,
          {
            action: toWireAction(action),
            // Already replayed above; resending would have the judge narrate a
            // history the pattern detector has counted, and double-tell the story.
            context: replay
              ? { sessionId: context.sessionId }
              : toWireContext(context),
          },
          timeoutMs,
          apiKey,
        ),
      retry,
    );

    return parseResult(payload, Math.round(performance.now() - startedAt));
  };
}

export type EngineHealth = {
  status: string;
  policies: number;
  retrieval: string;
  judgeModel: string;
  classifierModel?: string;
  openaiConfigured: boolean;
  /** True when the engine requires Authorization: Bearer (P2 commit a93cd8c). */
  authRequired?: boolean;
  storage?: Record<string, string>;
};

/** Liveness + config. Returns null when the service is not reachable at all. */
export async function engineHealth(
  baseUrl = engineBaseUrl(),
  apiKey = engineApiKey(),
): Promise<EngineHealth | null> {
  try {
    // /health is deliberately unauthenticated on P2's side, but send the header
    // anyway so this keeps working if that ever changes.
    const res = await fetch(`${baseUrl}/health`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as EngineHealth;
  } catch {
    return null;
  }
}

/**
 * Clear the engine's cumulative state.
 *
 * Scenario sessionIds are unique (`sess_<id>`), so scenarios cannot contaminate
 * each other within one run -- but the engine's in-memory store outlives a run,
 * so a second suite against the same process would replay priors onto state that
 * is already there and double every total. Call once before a suite.
 */
export async function resetEngineSessions(
  baseUrl = engineBaseUrl(),
  apiKey = engineApiKey(),
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/sessions/reset`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
