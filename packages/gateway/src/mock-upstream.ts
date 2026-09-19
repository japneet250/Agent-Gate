import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// A tiny fake tool server used to test the gateway without a real one.
export function createMockUpstream(): McpServer {
  const server = new McpServer({ name: 'mock-upstream', version: '0.1.0' });
  server.registerTool(
    'echo',
    { description: 'Echoes the message back', inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
  );
  server.registerTool(
    'lookup_order',
    { description: 'Looks up an order by id', inputSchema: { id: z.string() } },
    async ({ id }) => ({ content: [{ type: 'text', text: `order ${id}: shipped` }] }),
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createMockUpstream().connect(new StdioServerTransport());
}
