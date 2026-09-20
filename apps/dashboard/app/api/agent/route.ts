/**
 * Drive one of the demo agents, and stream what happens.
 *
 * This is a real tool-calling loop: gpt-4o is given the persona's real tool
 * schema and picks the calls itself. Every call it wants to make is then sent
 * to the real gateway, which runs the rule engine and, where the rules do not
 * decide, the judge. Nothing here is scripted — the same prompt can produce a
 * different tool call, and the verdict is whatever AgentGate actually returns.
 *
 * The response is newline-delimited JSON so the terminal fills as it happens.
 * A block that appears after a two-second pause reads as a system thinking; the
 * same block delivered all at once at the end reads as a recording.
 */
import { personaById } from '@/lib/personas';

export const dynamic = 'force-dynamic';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8787';
const KEY = process.env.AGENTGATE_API_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';

type ToolCall = { name: string; args: Record<string, unknown> };

async function chooseTools(
  persona: NonNullable<ReturnType<typeof personaById>>,
  task: string,
): Promise<{ calls: ToolCall[]; reply: string }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.2,
      messages: [
        { role: 'system', content: persona.system },
        { role: 'user', content: task },
      ],
      tools: persona.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const msg = body?.choices?.[0]?.message ?? {};
  const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function.arguments || '{}');
    } catch {
      // A malformed argument blob is the model's problem, not a reason to drop
      // the call: the gateway should still see the attempt.
    }
    return { name: c.function.name, args };
  });
  return { calls, reply: typeof msg.content === 'string' ? msg.content : '' };
}

async function evaluate(agentId: string, sessionId: string, call: ToolCall) {
  const res = await fetch(`${GATEWAY}/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ agentId, sessionId, toolName: call.name, toolArgs: call.args }),
    cache: 'no-store',
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`gateway returned ${res.status}`);
  return res.json();
}

export async function POST(request: Request) {
  const { agent, task, sessionId } = await request.json().catch(() => ({}));
  const persona = personaById(String(agent ?? ''));
  if (!persona) return Response.json({ error: 'unknown agent' }, { status: 400 });
  if (!String(task ?? '').trim()) return Response.json({ error: 'no task' }, { status: 400 });
  if (!OPENAI_KEY) {
    return Response.json({ error: 'OPENAI_API_KEY is not set for the dashboard process' }, { status: 503 });
  }

  const session = String(sessionId ?? `demo-${persona.id}`);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Closing twice throws ERR_INVALID_STATE, which tears down the response
      // mid-stream and leaves the terminal hanging on "reasoning…". The early
      // return for "model chose no tools" did exactly that.
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const emit = (o: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
      };
      const started = Date.now();
      try {
        emit({ type: 'status', text: 'reasoning about the request' });
        const { calls, reply } = await chooseTools(persona, task);

        if (calls.length === 0) {
          emit({
            type: 'reply',
            text: reply || 'No tool call was needed for that — nothing reached the firewall.',
            toolCalls: 0,
          });
          emit({ type: 'done', ms: Date.now() - started });
          return;
        }

        emit({ type: 'status', text: `${calls.length} tool call${calls.length > 1 ? 's' : ''} selected` });

        let blocked = 0;
        let held = 0;
        for (const call of calls) {
          emit({ type: 'call', tool: call.name, args: call.args });
          try {
            const v = await evaluate(persona.agentId, session, call);
            if (v.decision === 'block') blocked++;
            if (v.decision === 'escalate') held++;
            emit({
              type: 'verdict',
              tool: call.name,
              decision: v.decision,
              riskScore: v.riskScore,
              reasoning: v.reasoning,
              violatedPolicy: v.violatedPolicy ?? null,
              latencyMs: v.latencyMs,
              decidedBy: v.decidedBy ?? (v.latencyMs < 50 ? 'rules' : 'judge'),
            });
          } catch (err) {
            // A firewall that cannot answer must not let the call through, and
            // the terminal must say which happened.
            emit({ type: 'error', tool: call.name, text: (err as Error).message });
            blocked++;
          }
        }

        // The agent's own account of the outcome. Deterministic rather than a
        // second model call: it keeps the terminal responsive, and it must not
        // claim anything the verdicts did not say.
        const done = calls.length - blocked - held;
        const parts: string[] = [];
        if (done > 0) parts.push(`${done} action${done > 1 ? 's' : ''} completed`);
        if (held > 0) parts.push(`${held} sent for human review`);
        if (blocked > 0) parts.push(`${blocked} refused by AgentGate`);
        emit({
          type: 'reply',
          text: parts.join(', ') + '.',
          toolCalls: calls.length,
          blocked,
          held,
        });
        emit({ type: 'done', ms: Date.now() - started });
      } catch (err) {
        emit({ type: 'error', text: (err as Error).message });
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
  });
}
