import { judgeFromEnv } from './engine.js';
import { createEvaluator, withAuditLog, type Evaluator } from './evaluate.js';
import { handleRequest, json } from './handler.js';
import { createPolicyCache, insertActionLog, type D1Like } from './policies.js';
import { configFromEnv } from './rules.js';

// Cloudflare Worker logic (worker-entry.ts is the file wrangler deploys; it wraps this with Sentry): POST /evaluate and GET /health, with decisions logged to D1.
// (The MCP stdio proxy can't run on Workers, since it spawns local processes; only this HTTP side deploys.)
//
// Bindings / vars (see wrangler.jsonc):
//   DB                     D1 database (optional: without it nothing is logged and no policy is switchable)
//   AGENTGATE_API_KEY      REQUIRED secret. Callers send `Authorization: Bearer <key>`.
//   AGENTGATE_ALLOW_ANONYMOUS=1   skip the key requirement (local experiments only)
//   ENGINE_URL             Person 2's AI judge (must be reachable from Cloudflare, so not localhost). Unset = no judge.
//   AGENTGATE_BLOCKED_TOOLS, AGENTGATE_SPEND_LIMIT, AGENTGATE_RATE_LIMIT, AGENTGATE_RATE_WINDOW_MS   rule config

interface Env {
  DB?: D1Like;
  AGENTGATE_API_KEY?: string;
  AGENTGATE_ALLOW_ANONYMOUS?: string;
  [name: string]: unknown;
}
interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const stringVars = (env: Env) =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;

/**
 * Builds the Worker. State (rule engine, rate-limit counts, policy cache) lives in this closure, i.e. per isolate.
 * NOTE: the rate limiter's counts therefore reset whenever the isolate does and are not shared between isolates.
 * Good enough for a demo; a real deployment would keep them in D1 or a Durable Object.
 */
export function createWorker() {
  let shared: { evaluate: Evaluator; policies: ReturnType<typeof createPolicyCache> } | undefined;

  return {
    async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (pathname !== '/health' && !env.AGENTGATE_API_KEY && env.AGENTGATE_ALLOW_ANONYMOUS !== '1') {
        // Fail closed: a public endpoint with no key would let anyone fill the audit log and probe the rules.
        return json(503, { error: 'AGENTGATE_API_KEY is not configured' });
      }

      if (!shared) {
        const policies = createPolicyCache(env.DB);
        const vars = stringVars(env);
        shared = { policies, evaluate: createEvaluator(configFromEnv(vars), judgeFromEnv(vars), policies.isEnabled) };
      }
      await shared.policies.refresh();

      const { DB } = env;
      const evaluate = DB
        ? withAuditLog(shared.evaluate, (action, result) => void ctx.waitUntil(insertActionLog(DB, action, result)))
        : shared.evaluate;
      return handleRequest(req, evaluate, { apiKey: env.AGENTGATE_API_KEY });
    },
  };
}
