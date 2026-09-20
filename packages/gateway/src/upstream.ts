/**
 * Resolving the upstream MCP server the gateway sits in front of.
 *
 * Until now the gateway could only wrap a LOCAL process over stdio. Zip — and
 * every other vendor shipping a hosted agent surface — publishes a REMOTE MCP
 * server over HTTP. Governing a local mock tool server is a demo; governing a
 * vendor's real remote server is the product.
 *
 *   stdio   node ./server.js            a local process
 *   remote  https://mcp.zip.co/mcp      a hosted server, bearer token
 *
 * The gateway does not care which: it mirrors whatever tools the upstream
 * exposes and evaluates every call either way.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export type UpstreamSpec =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'remote'; url: string; token?: string; transport?: 'http' | 'sse' };

/**
 * `argv` is either a command and its arguments, or a single URL.
 *
 * A bare https:// argument is treated as a remote MCP server, which is how a
 * vendor's hosted server is normally addressed.
 */
export function parseUpstream(argv: string[], env: NodeJS.ProcessEnv = process.env): UpstreamSpec {
  const [first, ...rest] = argv;
  if (first && /^https?:\/\//i.test(first)) {
    return {
      kind: 'remote',
      url: first,
      token: env.AGENTGATE_UPSTREAM_TOKEN,
      transport: env.AGENTGATE_UPSTREAM_TRANSPORT === 'sse' ? 'sse' : 'http',
    };
  }
  return { kind: 'stdio', command: first, args: rest };
}

function describe(spec: UpstreamSpec): string {
  return spec.kind === 'stdio'
    ? `${spec.command} ${spec.args.join(' ')}`
    : `${spec.url} (${spec.transport}${spec.token ? ', authenticated' : ', no token'})`;
}

/** Connect to the upstream, whatever kind it is. */
export async function connectUpstream(spec: UpstreamSpec): Promise<Client> {
  const client = new Client({ name: 'agentgate-gateway', version: '0.1.0' });

  if (spec.kind === 'stdio') {
    await client.connect(new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      // The SDK otherwise passes only a safe subset of the environment, which
      // silently strips a vendor server's own configuration: ziphq-mcp came up
      // without ZIP_API_KEY or ZIP_MCP_MODE and exposed 60 read tools instead of
      // 131, so every write tool was invisible and nothing looked wrong.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
      stderr: 'inherit',
    }));
    console.error(`[agentgate] upstream: ${describe(spec)}`);
    return client;
  }

  // A remote server's credentials are ours to hold, never the agent's: the
  // agent talks to AgentGate, and only AgentGate talks to the vendor. That is
  // the point — an agent cannot bypass the firewall by calling Zip directly if
  // it never holds a Zip token.
  const requestInit = spec.token
    ? { headers: { Authorization: `Bearer ${spec.token}` } }
    : undefined;

  const url = new URL(spec.url);
  const transport =
    spec.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });

  try {
    await client.connect(transport);
  } catch (err) {
    const hint =
      spec.transport === 'sse'
        ? ''
        : '\n[agentgate] if the server speaks the older SSE transport, set AGENTGATE_UPSTREAM_TRANSPORT=sse';
    throw new Error(
      `could not connect to remote MCP server ${spec.url}: ${(err as Error).message}${hint}`,
    );
  }

  console.error(`[agentgate] upstream: ${describe(spec)}`);
  return client;
}
