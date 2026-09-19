import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mockServerCommand } from '../servers/launch.js';
import type { ToolServerName } from '../tools/catalog.js';

export type ToolClient = {
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
};

/**
 * Connects to a mock MCP tool server over stdio.
 *
 * TODO: once P1's gateway is up, point `command` at the gateway instead of the
 * mock server directly -- the gateway speaks the same MCP stdio protocol, so
 * nothing else in the agent needs to change.
 */
export async function connectToolServer(server: ToolServerName): Promise<ToolClient> {
  const transport = new StdioClientTransport({
    ...mockServerCommand(server),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'agentgate-demo-agent', version: '0.1.0' });
  await client.connect(transport);

  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n');
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
