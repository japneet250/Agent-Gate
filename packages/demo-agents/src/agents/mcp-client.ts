import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { gatewayEnabled, gatewayServerCommand, mockServerCommand } from '../servers/launch.js';
import type { ToolServerName } from '../tools/catalog.js';

export type ToolResult = {
  /** False when the call was refused — by AgentGate, or by the tool itself. */
  ok: boolean;
  text: string;
};

export type ToolClient = {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
};

/**
 * Connects to a mock MCP tool server over stdio — through AgentGate.
 *
 * The gateway is an MCP server that proxies another MCP server, so from here it
 * is the same protocol and nothing above this function changes. That is what
 * the original TODO anticipated.
 *
 * Every tool call now passes the rule engine and, when the rules do not decide,
 * the judge. AGENTGATE_BYPASS=1 restores the direct connection for the
 * "before AgentGate" half of a demo.
 */
export async function connectToolServer(server: ToolServerName): Promise<ToolClient> {
  const viaGateway = gatewayEnabled();
  const transport = new StdioClientTransport({
    ...(viaGateway ? gatewayServerCommand(server) : mockServerCommand(server)),
    // The gateway needs AGENTGATE_ENGINE_URL and its key to reach the judge;
    // the SDK passes only a safe subset of the environment by default.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    stderr: 'inherit',
  });
  if (!viaGateway) {
    console.error('[demo-agents] AGENTGATE_BYPASS=1 — tool calls are NOT being firewalled');
  }
  const client = new Client({ name: 'agentgate-demo-agent', version: '0.1.0' });
  await client.connect(transport);

  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n');
      // MCP signals a refusal with isError. Dropping it made a blocked call
      // indistinguishable from a successful one: the agent would carry on as
      // though the email had been sent, and a demo would show a block that the
      // agent never noticed.
      return { ok: res.isError !== true, text };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
