import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectUpstream, parseUpstream } from './upstream.js';
import { ActionLog } from './action-log.js';
import { judgeFromEnv } from './engine.js';
import { createEvaluator, withAuditLog } from './evaluate.js';
import { createGateway } from './gateway.js';
import { startHttpServer } from './http.js';
import { initSentryNode } from './sentry-node.js';

// Usage: tsx src/index.ts <upstream command> [args...]     a local stdio server
//        tsx src/index.ts https://mcp.vendor.com/mcp        a remote MCP server
// e.g.   tsx src/index.ts npx -y @modelcontextprotocol/server-filesystem /tmp
const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: tsx src/index.ts <upstream command> [args...]');
  console.error('       tsx src/index.ts <https://remote-mcp-url>   (AGENTGATE_UPSTREAM_TOKEN for auth)');
  process.exit(1);
}

await initSentryNode(process.env, 'mcp-proxy');

const upstream = await connectUpstream(parseUpstream(argv));

// One evaluator shared by both front doors, so rate limits count MCP and HTTP calls together.
const judge = judgeFromEnv();
// Every decision this process makes goes into the ring, MCP calls included.
// Previously only the Worker's HTTP route was audited, so tool calls through
// the MCP proxy — which is the whole product — were judged and then forgotten.
const actionLog = new ActionLog();
const evaluate = withAuditLog(createEvaluator(undefined, judge), (action, result) =>
  actionLog.record(action, result),
);
const server = createGateway(upstream, evaluate);
server.onclose = () => void upstream.close();
await server.connect(new StdioServerTransport());
// Optional: also serve POST /evaluate over HTTP from this same process.
if (process.env.AGENTGATE_HTTP_PORT) {
  const host = process.env.AGENTGATE_HTTP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AGENTGATE_HTTP_PORT);
  await startHttpServer(evaluate, {
    port, host,
    apiKey: process.env.AGENTGATE_API_KEY,
    // Serves GET /actions from the same ring, so the dashboard's live feed sees
    // MCP traffic too rather than only what came in over HTTP.
    recentActions: async (since) => actionLog.since(since),
  });
  console.error(`[agentgate] HTTP evaluate endpoint up on http://${host}:${port}/evaluate`);
}
console.error(`[agentgate] AI judge: ${judge ? 'configured' : 'NOT configured (AGENTGATE_ENGINE_URL unset): calls no rule catches are ALLOWED'}`);
console.error('[agentgate] proxy up');
