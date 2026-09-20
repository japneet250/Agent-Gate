import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectUpstream, parseUpstream } from './upstream.js';
import { ActionLog, sinkFromEnv } from './action-log.js';
import { D1ActionLog, d1ConfigFromEnv } from './d1-log.js';
import { judgeFromEnv } from './engine.js';
import { createEvaluator, withAuditLog } from './evaluate.js';
import { createGateway } from './gateway.js';
import { startHttpServer } from './http.js';
import { initSentryNode } from './sentry-node.js';
import { log } from './log.js';

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
// A gateway that serves the dashboard (AGENTGATE_HTTP_PORT) is the collector
// and keeps its own rows. A gateway spawned by an agent has no port and no
// reader, so it forwards to the collector named by AGENTGATE_ACTION_SINK.
// Never both: a collector forwarding to itself would double every row.
const isCollector = Boolean(process.env.AGENTGATE_HTTP_PORT);

// Durable audit trail. The ring dies with the process; D1 does not, so a
// restart no longer erases the record of what the firewall refused. Every
// gateway writes to it directly — a spawned one does not have to survive long
// enough for its rows to be forwarded anywhere.
const d1cfg = d1ConfigFromEnv();
const d1 = d1cfg ? new D1ActionLog(d1cfg) : undefined;

const actionLog = new ActionLog(undefined, (row) => {
  const writes: Promise<unknown>[] = [];
  if (d1) writes.push(d1.write(row).catch((err) => log('D1 audit write failed:', err.message)));
  // A non-collector also forwards to the collector's ring, so the dashboard
  // updates in the same second rather than at D1's pace.
  if (!isCollector) {
    const forward = sinkFromEnv();
    if (forward) writes.push(forward(row));
  }
  return Promise.all(writes).then(() => undefined);
});
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
    // D1 first so the feed survives a restart; the ring is the fallback when
    // Cloudflare is unreachable, and an empty feed then means empty, not lost.
    recentActions: async (since) => {
      if (d1) {
        try {
          return await d1.since(since);
        } catch (err) {
          log('D1 read failed, serving the in-memory ring:', (err as Error).message);
        }
      }
      return actionLog.since(since);
    },
    // Rows decided by the gateways that agents spawn land here.
    ingestAction: (row) => actionLog.ingest(row),
  });
  console.error(`[agentgate] HTTP evaluate endpoint up on http://${host}:${port}/evaluate`);
}
console.error(`[agentgate] AI judge: ${judge ? 'configured' : 'NOT configured (AGENTGATE_ENGINE_URL unset): calls no rule catches are ALLOWED'}`);
// A spawned gateway exits the moment its agent disconnects. Forwarded rows are
// in flight at that point, so wait for them or the dashboard misses the run.
const flush = () => void actionLog.flush();
process.on('beforeExit', flush);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void actionLog.flush().then(() => process.exit(0)));
}
server.onclose = () => {
  void actionLog.flush().finally(() => void upstream.close());
};

if (d1) {
  void d1.reachable().then((ok) =>
    console.error(
      ok
        ? `[agentgate] audit log: D1 ${d1cfg!.databaseId.slice(0, 8)} (durable)`
        : '[agentgate] audit log: D1 UNREACHABLE — decisions are in memory only and will be lost on restart',
    ),
  );
} else {
  console.error(
    '[agentgate] audit log: in memory only (set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID to persist)',
  );
}

console.error('[agentgate] proxy up');
