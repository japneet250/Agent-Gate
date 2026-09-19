import { judgeFromEnv } from './engine.js';
import { createEvaluator } from './evaluate.js';
import { startHttpServer } from './http.js';
import { log } from './log.js';
import { initSentryNode } from './sentry-node.js';

// Standalone HTTP mode: just POST /evaluate, no MCP upstream. This is what the demo bots talk to.
// Usage: npm run serve -w packages/gateway   (AGENTGATE_HTTP_PORT, AGENTGATE_HTTP_HOST, AGENTGATE_API_KEY)
await initSentryNode(process.env, 'http-server');
const port = Number(process.env.AGENTGATE_HTTP_PORT ?? 3000);
const host = process.env.AGENTGATE_HTTP_HOST ?? '127.0.0.1';
const judge = judgeFromEnv();
log(`AI judge: ${judge ? process.env.ENGINE_URL : 'not configured (ENGINE_URL unset), unmatched calls are allowed'}`);
await startHttpServer(createEvaluator(undefined, judge), { port, host, apiKey: process.env.AGENTGATE_API_KEY });
log(`HTTP evaluate endpoint up on http://${host}:${port}/evaluate${process.env.AGENTGATE_API_KEY ? ' (API key required)' : ''}`);
