import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentAction } from '@agentgate/shared';
import type { Evaluator } from './evaluate.js';
import { describeArgs, log } from './log.js';
import { decisionBreadcrumb, reportError } from './monitoring.js';

// HTTP front door for callers that aren't MCP clients (e.g. Person 3's demo bots).
//
//   POST /evaluate   body: { toolName, toolArgs, agentId?, sessionId?, id? }   (snake_case names work too)
//                    -> 200 { riskScore, decision, reasoning, violatedPolicy?, latencyMs }
//   GET  /health     -> 200 { ok: true }
//
// It only returns the decision; the caller is responsible for honouring it. The core is a plain
// Request -> Response function with no Node-only imports besides node:crypto, so it runs on Node (http.ts) and on
// Cloudflare Workers (worker.ts).

const MAX_BODY_BYTES = 1_000_000;

export interface HttpOptions {
  /** If set, POST /evaluate requires `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  maxBodyBytes?: number;
}

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

  if (pathname === '/health') return req.method === 'GET' ? json(200, { ok: true }) : json(405, { error: 'use GET' }, { allow: 'GET' });
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
