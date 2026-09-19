/**
 * Smoke test: spawns each mock MCP server over stdio, lists its tools and
 * calls one. Run with `npm run smoke -w @agentgate/demo-agents`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mockServerCommand } from './launch.js';
import type { ToolServerName } from '../tools/catalog.js';

const CASES: Array<{
  server: ToolServerName;
  tool: string;
  args: Record<string, unknown>;
}> = [
  {
    server: 'customer-support',
    tool: 'lookup_customer',
    args: { query: 'dana.whitfield@example.com' },
  },
  { server: 'procurement', tool: 'check_budget', args: { department: 'engineering' } },
  { server: 'coding', tool: 'run_command', args: { command: 'npm test' } },
];

async function main() {
  let failures = 0;

  for (const c of CASES) {
    const transport = new StdioClientTransport({
      ...mockServerCommand(c.server),
      stderr: 'inherit',
    });
    const client = new Client({ name: 'agentgate-smoke', version: '0.1.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      console.log(`\n[${c.server}] tools: ${names.join(', ')}`);

      const res = await client.callTool({ name: c.tool, arguments: c.args });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      console.log(`[${c.server}] ${c.tool} ->\n${text}`);
    } catch (err) {
      failures++;
      console.error(`[${c.server}] FAILED`, err);
    } finally {
      await client.close().catch(() => {});
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} server(s) failed`);
    process.exit(1);
  }
  console.log('\nAll 3 mock MCP servers OK.');
}

main();
