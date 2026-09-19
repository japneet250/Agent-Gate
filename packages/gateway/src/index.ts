import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { judgeFromEnv } from './engine.js';
import { createEvaluator } from './evaluate.js';
import { createGateway } from './gateway.js';
import { startHttpServer } from './http.js';
import { initSentryNode } from './sentry-node.js';

// Usage: tsx src/index.ts <upstream command> [args...]
// e.g.   tsx src/index.ts npx -y @modelcontextprotocol/server-filesystem /tmp
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: tsx src/index.ts <upstream command> [args...]');
  process.exit(1);
}

await initSentryNode(process.env, 'mcp-proxy');

const upstream = new Client({ name: 'agentgate-gateway', version: '0.1.0' });
await upstream.connect(new StdioClientTransport({ command, args, stderr: 'inherit' }));

// One evaluator shared by both front doors, so rate limits count MCP and HTTP calls together.
const judge = judgeFromEnv();
const evaluate = createEvaluator(undefined, judge);
const server = createGateway(upstream, evaluate);
server.onclose = () => void upstream.close();
await server.connect(new StdioServerTransport());
// Optional: also serve POST /evaluate over HTTP from this same process.
if (process.env.AGENTGATE_HTTP_PORT) {
  const host = process.env.AGENTGATE_HTTP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AGENTGATE_HTTP_PORT);
  await startHttpServer(evaluate, { port, host, apiKey: process.env.AGENTGATE_API_KEY });
  console.error(`[agentgate] HTTP evaluate endpoint up on http://${host}:${port}/evaluate`);
}
console.error(`[agentgate] AI judge: ${judge ? process.env.ENGINE_URL : 'not configured (ENGINE_URL unset), unmatched calls are allowed'}`);
console.error(`[agentgate] proxy up, forwarding to: ${command} ${args.join(' ')}`);
