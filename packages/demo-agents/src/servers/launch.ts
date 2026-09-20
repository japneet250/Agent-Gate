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
