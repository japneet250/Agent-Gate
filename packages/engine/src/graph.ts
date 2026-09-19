import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { ActionCategory, AgentAction, Decision, SessionContext } from '@agentgate/shared';
import { classifierNode } from './nodes/classifier.ts';
import { retrieverNode } from './nodes/retriever.ts';
import { judgeNode } from './nodes/judge.ts';
import { decisionGateNode } from './nodes/decisionGate.ts';
import { patternDetectorNode } from './nodes/patternDetector.ts';
import type { GraphState, GuardrailEvent, JudgeVerdict, RetrievedPolicy, SessionFacts } from './state.ts';
import { noopTrace, type Trace } from './trace.ts';

const last = <T,>(_: T, next: T) => next;
/** Guardrails accumulate across nodes; everything else is last-write-wins. */
const append = <T,>(prev: T[], next: T[]) => (prev === next ? prev : next);

export const StateAnnotation = Annotation.Root({
  action: Annotation<AgentAction>({ reducer: last }),
  context: Annotation<SessionContext>({ reducer: last }),
  sessionFacts: Annotation<SessionFacts>({
    reducer: last,
    default: () => ({
      actionsThisSession: 0,
      totalSpend: 0,
      dataAccessCount: 0,
      permissionRequests: 0,
      spendLimit: 0,
    }),
  }),
  category: Annotation<ActionCategory>({ reducer: last, default: () => 'other' }),
  categoryConfidence: Annotation<number>({ reducer: last, default: () => 0 }),
  policies: Annotation<RetrievedPolicy[]>({ reducer: last, default: () => [] }),
  verdict: Annotation<JudgeVerdict>({
    reducer: last,
    default: () => ({ riskScore: 50, reasoning: '' }),
  }),
  decision: Annotation<Decision>({ reducer: last, default: () => 'escalate' }),
  patternNotes: Annotation<string[]>({ reducer: append, default: () => [] }),
  guardrails: Annotation<GuardrailEvent[]>({ reducer: append, default: () => [] }),
  degraded: Annotation<boolean>({ reducer: (a, b) => a || b, default: () => false }),
  startedAt: Annotation<number>({ reducer: last, default: () => Date.now() }),
  trace: Annotation<Trace>({ reducer: last, default: () => noopTrace }),
});

/** Wrap a node so every execution becomes one LangFuse span with its latency. */
function traced(
  name: string,
  fn: (state: GraphState) => Partial<GraphState> | Promise<Partial<GraphState>>,
  input: (state: GraphState) => unknown,
) {
  return async (state: GraphState) => {
    const span = state.trace.span(name, input(state));
    const started = Date.now();
    try {
      const out = await fn(state);
      span.end({ ...out, trace: undefined, latencyMs: Date.now() - started });
      return out;
    } catch (err) {
      span.end({ error: (err as Error).message, latencyMs: Date.now() - started });
      throw err;
    }
  };
}

export function buildGraph() {
  return new StateGraph(StateAnnotation)
    .addNode(
      'classifier',
      traced('classifier.run', classifierNode, (s) => ({
        tool: s.action.toolName,
        args: s.action.toolArgs,
      })),
    )
    .addNode(
      'policy_retriever',
      traced('policy_retriever.search', retrieverNode, (s) => ({ category: s.category })),
    )
    .addNode(
      'risk_judge',
      traced('risk_judge.evaluate', judgeNode, (s) => ({
        category: s.category,
        policies: s.policies.map((p) => p.name),
      })),
    )
    .addNode(
      'decision_gate',
      traced('decision_gate.decide', decisionGateNode, (s) => ({ riskScore: s.verdict.riskScore })),
    )
    .addNode(
      'pattern_detector',
      traced('pattern_detector.check', patternDetectorNode, (s) => ({
        decision: s.decision,
        sessionId: s.context.sessionId,
      })),
    )
    .addEdge(START, 'classifier')
    .addEdge('classifier', 'policy_retriever')
    .addEdge('policy_retriever', 'risk_judge')
    .addEdge('risk_judge', 'decision_gate')
    .addEdge('decision_gate', 'pattern_detector')
    .addEdge('pattern_detector', END)
    .compile();
}

let compiled: ReturnType<typeof buildGraph> | null = null;
export function getGraph() {
  compiled ??= buildGraph();
  return compiled;
}
