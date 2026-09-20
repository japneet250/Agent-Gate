import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ToolServerName } from '../tools/catalog.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * How to spawn a mock MCP tool server over stdio.
 * P1: this is the stdio command to put behind the gateway.
 */
export function mockServerCommand(server: ToolServerName): {
  command: string;
  args: string[];
} {
  return {
    command: process.execPath,
    args: [require.resolve('tsx/cli'), path.join(here, `${server}.ts`)],
  };
}

/**
 * The same tool server, but behind AgentGate.
 *
 * The gateway is itself an MCP stdio server that proxies another one, so this
 * is the identical protocol from the agent's side — which is what makes the
 * swap invisible to everything above `connectToolServer`.
 *
 * Wrapping is the default: the agents exist to demonstrate a firewall, and one
 * that is bypassed by its own demo is not demonstrating anything. Set
 * AGENTGATE_BYPASS=1 to talk to the tool server directly, which is the
 * "before AgentGate" half of the demo.
 */
export function gatewayServerCommand(server: ToolServerName): {
  command: string;
  args: string[];
} {
  const upstream = mockServerCommand(server);
  const gateway = path.resolve(here, '../../../gateway/src/index.ts');
  return {
    command: process.execPath,
    args: [require.resolve('tsx/cli'), gateway, upstream.command, ...upstream.args],
  };
}

/** Whether tool calls currently go through AgentGate. */
export function gatewayEnabled(): boolean {
  return process.env.AGENTGATE_BYPASS !== '1';
}
