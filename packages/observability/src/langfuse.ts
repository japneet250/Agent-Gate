import { Langfuse } from 'langfuse';
import type { AgentAction, EvalResult } from '@agentgate/shared-types';

/**
 * Span naming, agreed across the team so one run reads as a single tree:
 *
 *   agentgate.agent.run            (P3) one demo-agent run / one eval suite
 *     agentgate.tool_call          (P3) one attempted tool call
 *       agentgate.evaluate         (P2) the evaluate() call -- P2 nests their
 *                                       judge / RAG / pattern-detector spans
 *                                       UNDER this one
 *       agentgate.tool_exec        (P3) the forwarded call to the real tool,
 *                                       absent when the decision was not allow
 */
export const SPAN = {
  agentRun: 'agentgate.agent.run',
  toolCall: 'agentgate.tool_call',
  evaluate: 'agentgate.evaluate',
  toolExec: 'agentgate.tool_exec',
} as const;

let client: Langfuse | undefined;

export function initLangfuse(): Langfuse | undefined {
  if (client) return client;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    console.warn('[langfuse] keys not set -- tracing disabled');
    return undefined;
  }
  client = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
  });
  return client;
}

export const langfuseEnabled = (): boolean => client !== undefined;

/**
 * A trace covers one agent run or one eval suite. The returned handle is a
 * no-op when tracing is disabled, so callers never need to branch.
 */
export type RunTrace = {
  toolCall: (action: AgentAction) => ToolCallSpan;
  update: (output: Record<string, unknown>) => void;
};

export type ScoreInfo = {
  scenarioId: string;
  expected: string;
  correct: boolean;
};

export type ToolCallSpan = {
  evaluated: (result: EvalResult) => void;
  executed: (output: string | undefined) => void;
  /** Attaches a correctness score, making the trace self-evaluating. */
  scored: (info: ScoreInfo) => void;
  end: () => void;
};

const NOOP_TOOL_CALL: ToolCallSpan = {
  evaluated: () => {},
  executed: () => {},
  scored: () => {},
  end: () => {},
};

export function startRunTrace(params: {
  name?: string;
  sessionId: string;
  agentId: string;
  metadata?: Record<string, unknown>;
}): RunTrace {
  const lf = client;
  if (!lf) return { toolCall: () => NOOP_TOOL_CALL, update: () => {} };

  const trace = lf.trace({
    name: params.name ?? SPAN.agentRun,
    sessionId: params.sessionId,
    userId: params.agentId,
    metadata: params.metadata,
  });

  return {
    update(output) {
      trace.update({ output });
    },
    toolCall(action) {
      const span = trace.span({
        name: SPAN.toolCall,
        input: { toolName: action.toolName, toolArgs: action.toolArgs },
        metadata: { actionId: action.id, agentId: action.agentId },
      });

      let evalSpan: ReturnType<typeof span.span> | undefined;
      let execSpan: ReturnType<typeof span.span> | undefined;
      let decision: string | undefined;

      return {
        evaluated(result) {
          decision = result.decision;
          // A child span rather than a sibling: P2's engine internals hang off this.
          evalSpan = span.span({
            name: SPAN.evaluate,
            input: { toolName: action.toolName, toolArgs: action.toolArgs },
            output: {
              decision: result.decision,
              riskScore: result.riskScore,
              violatedPolicy: result.violatedPolicy ?? null,
              reasoning: result.reasoning,
            },
            level: result.decision === 'block' ? 'WARNING' : 'DEFAULT',
            statusMessage: result.reasoning,
          });
          evalSpan.end();
        },
        executed(output) {
          execSpan = span.span({ name: SPAN.toolExec, output: { result: output ?? null } });
          execSpan.end();
        },
        scored(info) {
          span.score({
            name: 'decision_correctness',
            value: info.correct ? 1 : 0,
            comment: info.correct
              ? `${info.scenarioId}: matched label ${info.expected}`
              : `${info.scenarioId}: expected ${info.expected}, got ${decision ?? 'unknown'}`,
          });
        },
        end() {
          span.end({ output: { decision: decision ?? 'unknown' } });
        },
      };
    },
  };
}

/** Short-lived processes must flush before exit or the trace never lands. */
export async function flushLangfuse(): Promise<void> {
  await client?.flushAsync().catch(() => {});
}
