# Connecting an AI agent to AgentGate over MCP

AgentGate is an **MCP proxy**. You do not point your agent at a tool server —
you point it at AgentGate, and AgentGate points at the tool server. It mirrors
the upstream server's tools, so the agent sees no difference until something is
refused.

```
Claude Desktop / Cursor / Codex
        │  stdio (MCP)
        ▼
  AgentGate gateway  ──► rules (~1ms, no LLM)
        │                  └─ no match ──► engine judge (~2s)
        ▼  allow
  the real tool server
```

## Run it

The engine must be up first — the launcher refuses to start without it, because
a firewall silently running rules-only is worse than one that fails loudly.

```bash
cd packages/engine && ./venv/bin/uvicorn server:app --port 8000   # terminal 1

export AGENTGATE_ENGINE_URL=http://localhost:8000/evaluate        # terminal 2
export AGENTGATE_ENGINE_KEY="$AGENTGATE_API_KEY"                  # from .env
npm run mcp -w packages/gateway -- customer-support
```

Servers available: `customer-support`, `procurement`, `coding`. These are the
real tool servers from `packages/demo-agents`, with the nine tools from the
spec — not fixtures.

Override `AGENTGATE_ALLOW_NO_JUDGE=1` to run rules-only on purpose.

## Claude Desktop

```bash
npm run mcp -w packages/gateway -- --config
```

Prints a ready `mcpServers` block with absolute paths, an explicit `PATH`
(Claude Desktop launches servers from `/` with a minimal environment), and the
engine URL and key from your shell.

Merge it into `~/Library/Application Support/Claude/claude_desktop_config.json`
— **merge, do not overwrite**, or you will lose any MCP servers already
configured. Then fully quit Claude Desktop (Cmd+Q) and reopen.

Ask Claude to email a customer their SSN and watch it get refused in about a
millisecond, by the rule engine, before the tool is ever called.

## Cursor, Codex, Windsurf, Zed

Same `mcpServers` shape, different file. Nothing here is Claude-specific — that
is the point of building on MCP.

## What is and is not a fixture

`src/mock-upstream.ts` is a two-tool stub used **only** by `src/smoke-test.ts`,
so the gateway's own tests do not need the demo-agents package. It is not part
of any run path above. `src/fake-engine.ts` is the same idea for the judge: a
local stand-in so the gateway can be exercised without the Python engine
running. Neither is reachable from `npm run mcp`.
