import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolsFor, type ToolServerName } from '../tools/catalog.js';

/**
 * Mock MCP tool server: logs whatever it receives, returns a canned success.
 * There is no real side effect anywhere in here -- that is the point. AgentGate
 * sits in front of these, so the interesting behaviour is the decision, not the tool.
 */
export function buildServer(serverName: ToolServerName): McpServer {
  const server = new McpServer({ name: `agentgate-mock-${serverName}`, version: '0.1.0' });

  for (const tool of toolsFor(serverName)) {
    server.tool(tool.name, tool.description, tool.schema.shape, async (args) => {
      // stderr, so we never corrupt the stdio JSON-RPC stream on stdout.
      console.error(
        `[mock:${serverName}] ${tool.name} ${JSON.stringify(args)}`,
      );
      const result = tool.respond(args as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    });
  }

  return server;
}

export async function startStdioServer(serverName: ToolServerName): Promise<void> {
  const server = buildServer(serverName);
  await server.connect(new StdioServerTransport());
  console.error(`[mock:${serverName}] listening on stdio`);
}
