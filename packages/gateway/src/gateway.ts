import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentAction, EvalResult } from '@agentgate/shared';
import { createEvaluator, type Evaluator } from './evaluate.js';
import { describeArgs, log } from './log.js';
import { decisionBreadcrumb, reportError } from './monitoring.js';

const blocked = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * Builds the MCP server the agent talks to. It mirrors the upstream server's tools,
 * and every tool call is evaluated before being forwarded (allow) or refused (block/escalate).
 */
export function createGateway(upstream: Client, evaluate: Evaluator = createEvaluator()): Server {
  const sessionId = randomUUID();
  const server = new Server({ name: 'agentgate', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await upstream.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const action: AgentAction = {
      id: randomUUID(),
      agentId: server.getClientVersion()?.name ?? 'unknown',
      toolName: name,
      toolArgs: args ?? {},
      timestamp: new Date(),
      sessionId,
    };
    log('intercepted', JSON.stringify({ tool: action.toolName, args: describeArgs(action.toolArgs), agent: action.agentId }));

    // Fail closed: if evaluation itself breaks, the call does not go through.
    let result: EvalResult;
    try {
      result = await evaluate(action);
    } catch (err) {
      log('evaluator error, blocking:', err);
      reportError(err, 'mcp-evaluator');
      return blocked('This action was blocked because: the safety check failed to run.');
    }
    decisionBreadcrumb(action, result);
    log('decision', result.decision, `risk=${result.riskScore}`, result.reasoning);

    switch (result.decision) {
      case 'allow':
        return (await upstream.callTool({ name, arguments: args })) as CallToolResult;
      case 'escalate':
        // Escalation has no reviewer yet, so it is logged and blocked.
        return blocked(`This action needs review and was blocked because: ${result.reasoning}`);
      default:
        return blocked(`This action was blocked because: ${result.reasoning}`);
    }
  });

  return server;
}
