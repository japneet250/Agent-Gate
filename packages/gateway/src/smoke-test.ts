import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EvalResult } from '@agentgate/shared';
import { createGateway } from './gateway.js';
import { createMockUpstream } from './mock-upstream.js';
import type { Evaluator } from './evaluate.js';

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const verdict = (decision: EvalResult['decision'], reasoning = 'test'): EvalResult =>
  ({ decision, riskScore: 0, reasoning, latencyMs: 0 });

// Wires agent -> gateway -> mock upstream in-process, with a swappable evaluator.
async function connect(evaluate?: Evaluator) {
  const [upstreamClientSide, upstreamServerSide] = InMemoryTransport.createLinkedPair();
  await createMockUpstream().connect(upstreamServerSide);
  const upstream = new Client({ name: 'gateway', version: '0' });
  await upstream.connect(upstreamClientSide);

  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await createGateway(upstream, evaluate).connect(gatewaySide);
  const agent = new Client({ name: 'test-agent', version: '0' });
  await agent.connect(agentSide);
  return agent;
}

async function run(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`ok  ${name}`);
}

await run('lists the upstream tools', async () => {
  const agent = await connect();
  const names = (await agent.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['echo', 'lookup_order']);
});

await run('allow: call is forwarded and result returned', async () => {
  const agent = await connect(); // default stub allows everything
  const r = (await agent.callTool({ name: 'echo', arguments: { message: 'hi' } })) as CallToolResult;
  assert.equal(text(r), 'echo: hi');
  assert.notEqual(r.isError, true);
});

await run('block: call is refused with the reason', async () => {
  const agent = await connect(async () => verdict('block', 'contains an SSN'));
  const r = (await agent.callTool({ name: 'echo', arguments: { message: 'hi' } })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.equal(text(r), 'This action was blocked because: contains an SSN');
});

await run('escalate: logged and blocked for now', async () => {
  const agent = await connect(async () => verdict('escalate', 'unsure'));
  const r = (await agent.callTool({ name: 'echo', arguments: { message: 'hi' } })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.match(text(r), /needs review and was blocked because: unsure/);
});

await run('evaluator receives a well-formed AgentAction', async () => {
  let seen: Parameters<Evaluator>[0] | undefined;
  const agent = await connect(async (a) => ((seen = a), verdict('allow')));
  await agent.callTool({ name: 'lookup_order', arguments: { id: '123' } });
  assert.equal(seen?.toolName, 'lookup_order');
  assert.deepEqual(seen?.toolArgs, { id: '123' });
  assert.equal(seen?.agentId, 'test-agent');
  assert.ok(seen?.id && seen.sessionId && seen.timestamp instanceof Date);
});

await run('fail closed: evaluator crash blocks the call', async () => {
  const agent = await connect(async () => {
    throw new Error('boom');
  });
  const r = (await agent.callTool({ name: 'echo', arguments: { message: 'hi' } })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.match(text(r), /safety check failed to run/);
});

await run('default rules: SSN blocked fast with a clear reason, safe call still goes through', async () => {
  const agent = await connect(); // default evaluator = rule engine
  const t = performance.now();
  const bad = (await agent.callTool({ name: 'echo', arguments: { message: 'my SSN is 123-45-6789' } })) as CallToolResult;
  const ms = performance.now() - t;
  assert.equal(bad.isError, true);
  assert.equal(text(bad), 'This action was blocked because: PII detected: SSN in "message"');
  assert.ok(!text(bad).includes('123-45-6789'));
  console.log(`    blocked round trip (agent -> gateway -> rules -> agent): ${ms.toFixed(1)}ms`);
  const good = (await agent.callTool({ name: 'lookup_order', arguments: { id: '123' } })) as CallToolResult;
  assert.equal(text(good), 'order 123: shipped');
});

// Real end-to-end over stdio: this is the path Claude Desktop uses.
await run('stdio e2e: spawned CLI proxies a spawned upstream', async () => {
  const node = process.execPath;
  const agent = new Client({ name: 'stdio-agent', version: '0' });
  await agent.connect(
    new StdioClientTransport({
      command: node,
      args: ['--import', 'tsx', 'src/index.ts', node, '--import', 'tsx', 'src/mock-upstream.ts'],
      stderr: 'inherit',
    }),
  );
  const r = (await agent.callTool({ name: 'echo', arguments: { message: 'over stdio' } })) as CallToolResult;
  assert.equal(text(r), 'echo: over stdio');
  await agent.close();
});

console.log('all smoke tests passed');
