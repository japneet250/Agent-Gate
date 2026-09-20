import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgentAction,
  Decision,
  EvalResult,
  SessionContext,
} from '@agentgate/shared-types';
import { toolsFor, type ToolServerName } from '../tools/catalog.js';
import { connectToolServer } from './mcp-client.js';
import { makeAction, passThroughGate, type ToolGate } from './gate.js';

export type StepLog = {
  action: AgentAction;
  evaluation: EvalResult;
  /** Tool output, or undefined when the gate blocked the call. */
  output?: string;
};

export type RunResult = {
  agentId: string;
  sessionId: string;
  steps: StepLog[];
  finalMessage?: string;
};

export type RunOptions = {
  agentId: string;
  server: ToolServerName;
  sessionId: string;
  gate?: ToolGate;
  /** Called after every gated step -- used for Sentry breadcrumbs / LangFuse spans. */
  onStep?: (step: StepLog) => void | Promise<void>;
};

function emptyContext(sessionId: string): SessionContext {
  return { sessionId, recentActions: [], cumulative: { spend: 0, dataAccessCount: 0 } };
}

/**
 * Cumulative totals only count calls that actually went through, and spend is
 * booked once per payment (not again on the matching purchase order) so a
 * threshold-split shows up as real money leaving, not as double counting.
 */
function advanceContext(
  ctx: SessionContext,
  action: AgentAction,
  decision: Decision,
): SessionContext {
  const executed = decision === 'allow';
  const amount = action.toolArgs.amount;
  const spent =
    executed && action.toolName === 'approve_payment' && typeof amount === 'number'
      ? amount
      : 0;
  const isDataRead =
    executed &&
    (action.toolName === 'lookup_customer' || action.toolName === 'query_database');
  return {
    sessionId: ctx.sessionId,
    recentActions: [...ctx.recentActions, action].slice(-20),
    cumulative: {
      spend: ctx.cumulative.spend + spent,
      dataAccessCount: ctx.cumulative.dataAccessCount + (isDataRead ? 1 : 0),
    },
  };
}

const DECISION_MARK: Record<Decision, string> = {
  allow: 'ALLOW',
  escalate: 'ESCALATE',
  block: 'BLOCK',
};

/**
 * Executes one tool call through the gate. Shared by the scripted and LLM runners
 * so both take exactly the same path through AgentGate.
 */
async function gatedCall(
  opts: Required<Pick<RunOptions, 'agentId'>> & {
    gate: ToolGate;
    ctx: SessionContext;
    toolName: string;
    toolArgs: Record<string, unknown>;
    exec: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
    onStep?: RunOptions['onStep'];
  },
): Promise<{ step: StepLog; ctx: SessionContext }> {
  const action = makeAction(opts.agentId, opts.ctx.sessionId, opts.toolName, opts.toolArgs);
  const evaluation = await opts.gate(action, opts.ctx);

  let output: string | undefined;
  let refusedDownstream = false;
  if (evaluation.decision === 'allow') {
    const res = await opts.exec(opts.toolName, opts.toolArgs);
    output = res.text;
    // The gateway refuses with an MCP error rather than an exception, so a
    // refusal has to be read off the result. Treating it as success would have
    // the agent report an email as sent that AgentGate had just stopped.
    if (!res.ok) refusedDownstream = true;
  } else {
    output = undefined;
  }

  // When the agent's own gate allowed a call but AgentGate refused it
  // downstream, the gateway's verdict is the real one. Recording the local
  // "allow" would make every log, every eval and the demo itself claim an
  // action succeeded that was in fact stopped.
  const finalEvaluation: EvalResult = refusedDownstream
    ? {
        ...evaluation,
        decision: 'block',
        reasoning: output ?? 'refused by AgentGate',
        riskScore: Math.max(evaluation.riskScore, 70),
      }
    : evaluation;

  const step: StepLog = {
    action,
    evaluation: finalEvaluation,
    output: refusedDownstream ? undefined : output,
  };
  console.log(
    `  [${DECISION_MARK[finalEvaluation.decision]} risk=${finalEvaluation.riskScore}] ${opts.toolName}(${JSON.stringify(opts.toolArgs)})`,
  );
  console.log(`    -> ${evaluation.reasoning}`);
  await opts.onStep?.(step);

  return { step, ctx: advanceContext(opts.ctx, action, evaluation.decision) };
}

/** Deterministic run: a fixed list of tool calls, no LLM or API key needed. */
export async function runScript(
  opts: RunOptions,
  script: Array<{ tool: string; args: Record<string, unknown> }>,
): Promise<RunResult> {
  const gate = opts.gate ?? passThroughGate;
  const client = await connectToolServer(opts.server);
  let ctx = emptyContext(opts.sessionId);
  const steps: StepLog[] = [];

  try {
    for (const call of script) {
      const r = await gatedCall({
        agentId: opts.agentId,
        gate,
        ctx,
        toolName: call.tool,
        toolArgs: call.args,
        exec: client.call,
        onStep: opts.onStep,
      });
      steps.push(r.step);
      ctx = r.ctx;
    }
  } finally {
    await client.close();
  }

  return { agentId: opts.agentId, sessionId: opts.sessionId, steps };
}

/** LLM run: a real OpenAI tool-calling loop. Needs OPENAI_API_KEY. */
export async function runAgent(
  opts: RunOptions & { task: string; systemPrompt: string; maxTurns?: number },
): Promise<RunResult> {
  const gate = opts.gate ?? passThroughGate;
  const openai = new OpenAI();
  const client = await connectToolServer(opts.server);
  let ctx = emptyContext(opts.sessionId);
  const steps: StepLog[] = [];

  const tools = toolsFor(opts.server).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema) as Record<string, unknown>,
    },
  }));

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.task },
  ];

  let finalMessage: string | undefined;

  try {
    for (let turn = 0; turn < (opts.maxTurns ?? 6); turn++) {
      const res = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        messages,
        tools,
      });
      const msg = res.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        finalMessage = msg.content ?? undefined;
        break;
      }

      for (const call of calls) {
        if (call.type !== 'function') continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = { _raw: call.function.arguments };
        }

        const r = await gatedCall({
          agentId: opts.agentId,
          gate,
          ctx,
          toolName: call.function.name,
          toolArgs: args,
          exec: client.call,
          onStep: opts.onStep,
        });
        steps.push(r.step);
        ctx = r.ctx;

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content:
            r.step.output ??
            `AgentGate ${r.step.evaluation.decision.toUpperCase()}ED this call: ${r.step.evaluation.reasoning}`,
        });
      }
    }
  } finally {
    await client.close();
  }

  return { agentId: opts.agentId, sessionId: opts.sessionId, steps, finalMessage };
}
