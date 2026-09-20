#!/usr/bin/env node
/**
 * Production MCP entry point.
 *
 *   npm run mcp -w packages/gateway -- customer-support
 *   npm run mcp -w packages/gateway -- --config        # print Claude Desktop config
 *
 * Puts AgentGate in front of one of the real tool servers. `src/index.ts` takes
 * an arbitrary upstream command; this resolves the server by name so nobody has
 * to remember absolute paths, and refuses to start against a judge that is not
 * answering — a firewall silently running rules-only is worse than one that
 * fails loudly.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const TSX = require.resolve('tsx/cli');

export const SERVERS = ['customer-support', 'procurement', 'coding', 'zip'] as const;
export type ServerName = (typeof SERVERS)[number];

/**
 * Zip ships its own MCP server (`ziphq-mcp`, run through uv). It exposes 131
 * tools, twelve of which delete things — users, vendors, subsidiaries — plus the
 * whole purchase, invoice and budget surface. An agent pointed straight at it
 * has that reach with nothing in between, which is precisely the gap AgentGate
 * exists to close.
 *
 * Needs ZIP_API_KEY and ZIP_API_URL. ZIP_MCP_MODE=readwrite is what makes the
 * write tools available at all; leave it unset for a read-only surface.
 */
function zipUpstream(): { command: string; args: string[] } {
  const home = process.env.HOME ?? '';
  return { command: `${home}/.local/bin/ziphq-mcp`, args: [] };
}

const serverPath = (s: ServerName) =>
  path.join(REPO, 'packages/demo-agents/src/servers', `${s}.ts`);

/** The argv that puts the gateway in front of `server`. */
export function proxyCommand(server: ServerName) {
  const upstream =
    server === 'zip'
      ? zipUpstream()
      : { command: process.execPath, args: [TSX, serverPath(server)] };
  return {
    command: process.execPath,
    args: [TSX, path.join(here, 'index.ts'), upstream.command, ...upstream.args],
  };
}

function claudeDesktopConfig() {
  const entries = Object.fromEntries(
    SERVERS.map((s) => {
      const { command, args } = proxyCommand(s);
      return [
        `agentgate-${s}`,
        {
          command,
          args,
          env: {
            // Claude Desktop launches servers from / with a minimal PATH.
            PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${process.env.HOME}/.local/bin`,
            ...(s === 'zip'
              ? {
                  ZIP_API_URL: process.env.ZIP_API_URL ?? 'https://staging-api.zip.com',
                  ZIP_API_KEY: process.env.ZIP_API_KEY ?? '<your Zip API key>',
                  ZIP_MCP_MODE: process.env.ZIP_MCP_MODE ?? 'readwrite',
                }
              : {}),
            AGENTGATE_ENGINE_URL:
              process.env.AGENTGATE_ENGINE_URL ?? 'http://localhost:8000/evaluate',
            AGENTGATE_ENGINE_KEY: process.env.AGENTGATE_ENGINE_KEY ?? '<AGENTGATE_API_KEY from .env>',
          },
        },
      ];
    }),
  );
  return { mcpServers: entries };
}

async function judgeReachable(): Promise<string> {
  const url = process.env.AGENTGATE_ENGINE_URL;
  if (!url) return 'AGENTGATE_ENGINE_URL is not set';
  try {
    const health = url.replace(/\/evaluate\/?$/, '') + '/health';
    const res = await fetch(health, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return `engine /health returned ${res.status}`;
    const body: any = await res.json();
    if (body.retrieval !== 'hybrid') {
      console.error(`[agentgate] warning: engine retrieval is "${body.retrieval}", not hybrid`);
    }
    return '';
  } catch (err) {
    return `cannot reach the engine: ${(err as Error).message}`;
  }
}

async function main() {
  const arg = process.argv[2];

  if (arg === '--config') {
    console.log(JSON.stringify(claudeDesktopConfig(), null, 2));
    return;
  }

  if (!arg || !SERVERS.includes(arg as ServerName)) {
    console.error(`usage: npm run mcp -w packages/gateway -- <${SERVERS.join('|')}>`);
    console.error(`       npm run mcp -w packages/gateway -- --config`);
    process.exit(1);
  }

  const problem = await judgeReachable();
  if (problem) {
    console.error(`[agentgate] refusing to start: ${problem}`);
    console.error('[agentgate] start the engine first:');
    console.error('  cd packages/engine && ./venv/bin/uvicorn server:app --port 8000');
    console.error('[agentgate] to run rules-only anyway, set AGENTGATE_ALLOW_NO_JUDGE=1');
    if (!process.env.AGENTGATE_ALLOW_NO_JUDGE) process.exit(1);
  }

  const { command, args } = proxyCommand(arg as ServerName);
  spawn(command, args, { stdio: 'inherit', env: process.env }).on('exit', (c) => process.exit(c ?? 0));
}

if (process.argv[1] && process.argv[1].includes('mcp')) void main();
