import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentAction } from '@agentgate/shared';
import type { Evaluator } from './evaluate.js';
import { describeArgs, log } from './log.js';
import { decisionBreadcrumb, reportError } from './monitoring.js';

// HTTP front door for callers that aren't MCP clients (e.g. Person 3's demo bots).
//
//   POST /evaluate   body: { toolName, toolArgs, agentId?, sessionId?, id? }   (snake_case names work too)
//                    -> 200 { riskScore, decision, reasoning, violatedPolicy?, latencyMs }
//   GET  /actions    ?since=<epoch ms> -> 200 [ActionLogRow, ...]   the decision feed the dashboard reads
//   GET  /health     -> 200 { ok: true }
//
// It only returns the decision; the caller is responsible for honouring it. The core is a plain
// Request -> Response function with no Node-only imports besides node:crypto, so it runs on Node (http.ts) and on
// Cloudflare Workers (worker.ts).

const MAX_BODY_BYTES = 1_000_000;

/** One decided action, in the column names the D1 `action_logs` table uses. */
export interface ActionLogRow {
  action_id: string;
  created_at: string;
  agent_id: string;
  session_id: string;
  tool_name: string;
  tool_args: string | null;
  decision: string;
  risk_score: number;
  reasoning: string;
  violated_policy: string | null;
  latency_ms: number;
  category: string | null;
  degraded: number;
  decided_by: string | null;
  retrieved_policies: string | null;
  pattern_notes: string | null;
}

export interface HttpOptions {
  /** If set, POST /evaluate requires `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  maxBodyBytes?: number;
  /**
   * Source for GET /actions. The Worker reads D1; a local process keeps a
   * ring in memory, because there is no D1 binding outside the Worker runtime
   * and a demo that only works once deployed is not much of a demo.
   *
   * Absent means the route answers 501 rather than an empty list — an empty
   * feed and an unwired feed look identical on screen, and the difference
   * matters when you are trying to work out why nothing is appearing.
   */
  recentActions?: (sinceMs: number) => Promise<ActionLogRow[]>;
  /**
   * Sink for POST /ingest: rows decided by another gateway process. Agents
   * spawn their own gateway, so without this the collector's feed only ever
   * shows traffic that arrived over its own HTTP port.
   */
  ingestAction?: (row: ActionLogRow) => void;
}

/**
 * Read-only routes are cross-origin on purpose: the dashboard runs on its own
 * port. POST /evaluate is deliberately NOT included — it spends money and
 * carries a bearer token, so it stays same-origin.
 */
const CORS = { 'access-control-allow-origin': '*' };

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

class BadRequest extends Error {}

const pick = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);
const nonEmpty = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : fallback);

/** Turns a request body into an AgentAction. The timestamp is always server time: a client-supplied one could dodge the rate limiter. */
export function parseAction(body: unknown): AgentAction {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;

  const toolName = pick(b, 'toolName', 'tool_name');
  if (typeof toolName !== 'string' || !toolName.trim() || toolName.length > 200) {
    throw new BadRequest('toolName must be a non-empty string (max 200 chars)');
  }
  const toolArgs = pick(b, 'toolArgs', 'tool_args') ?? {};
  if (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
    throw new BadRequest('toolArgs must be a JSON object');
  }

  return {
    id: nonEmpty(pick(b, 'id'), crypto.randomUUID()),
    agentId: nonEmpty(pick(b, 'agentId', 'agent_id'), 'unknown'),
    toolName,
    toolArgs: toolArgs as Record<string, unknown>,
    timestamp: new Date(),
    // No sessionId given: group by agent (not one shared bucket), so the engine's per-session detection still means something.
    sessionId: nonEmpty(pick(b, 'sessionId', 'session_id'), `agent:${nonEmpty(pick(b, 'agentId', 'agent_id'), 'unknown')}`),
  };
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const authorized = (req: Request, apiKey: string) =>
  timingSafeEqual(sha(req.headers.get('authorization') ?? ''), sha(`Bearer ${apiKey}`));

export async function handleRequest(req: Request, evaluate: Evaluator, opts: HttpOptions = {}): Promise<Response> {
  const { pathname } = new URL(req.url);

  // The dashboard is served from another origin (:3100) and probes this to
  // decide whether to show "backend down". Without the header the browser
  // blocks the response and a perfectly healthy gateway is reported as dead.
  if (pathname === '/health') {
    return req.method === 'GET'
      ? json(200, { ok: true }, CORS)
      : json(405, { error: 'use GET' }, { allow: 'GET', ...CORS });
  }

  if (pathname === '/actions') {
    if (req.method !== 'GET') return json(405, { error: 'use GET' }, { allow: 'GET' });
    if (!opts.recentActions) {
      return json(501, { error: 'no action log configured on this gateway' });
    }
    const since = Number(new URL(req.url).searchParams.get('since') ?? 0);
    try {
      const rows = await opts.recentActions(Number.isFinite(since) ? since : 0);
      // The dashboard polls this; browsers enforce same-origin, and it is a
      // read-only feed of already-redacted rows.
      return json(200, rows, CORS);
    } catch (err) {
      reportError(err, 'GET /actions');
      return json(500, { error: 'could not read the action log' });
    }
  }

  if (pathname === '/ingest') {
    if (req.method !== 'POST') return json(405, { error: 'use POST' }, { allow: 'POST' });
    if (!opts.ingestAction) return json(501, { error: 'no action log configured on this gateway' });
    try {
      const row = (await req.json()) as ActionLogRow;
      if (!row || typeof row.action_id !== 'string' || typeof row.decision !== 'string') {
        return json(400, { error: 'not an action row' });
      }
      opts.ingestAction(row);
      return json(202, { ok: true });
    } catch {
      return json(400, { error: 'invalid JSON' });
    }
  }

  if (pathname !== '/evaluate') return json(404, { error: 'not found' });
  if (req.method !== 'POST') return json(405, { error: 'use POST' }, { allow: 'POST' });
  if (opts.apiKey && !authorized(req, opts.apiKey)) return json(401, { error: 'missing or invalid API key' });

  const text = await req.text();
  if (new TextEncoder().encode(text).length > (opts.maxBodyBytes ?? MAX_BODY_BYTES)) return json(413, { error: 'body too large' });

  let action: AgentAction;
  try {
    action = parseAction(JSON.parse(text));
  } catch (err) {
    return json(400, { error: err instanceof BadRequest ? err.message : 'body is not valid JSON' });
  }

  try {
    const result = await evaluate(action);
    decisionBreadcrumb(action, result);
    log('http evaluate', JSON.stringify({ tool: action.toolName, args: describeArgs(action.toolArgs), agent: action.agentId }), result.decision, `risk=${result.riskScore}`, result.reasoning);
    return json(200, result);
  } catch (err) {
    // Fail closed: callers that read `decision` still see a block.
    log('http evaluator error, blocking:', err);
    reportError(err, 'http-evaluator');
    return json(500, {
      error: 'evaluation failed',
      decision: 'block',
      riskScore: 100,
      reasoning: 'the safety check failed to run',
      latencyMs: 0,
    });
  }
}
