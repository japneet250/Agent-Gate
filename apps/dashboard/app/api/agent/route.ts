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

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type Msg = Record<string, unknown>;

/** How many model turns one task may take. A real agent looks something up and
 *  then acts on it, which is exactly the sequence worth showing: the lookup is
 *  allowed, the thing it does next is not. Three is enough for that and short
 *  enough to stay watchable. */
const MAX_TURNS = 3;

async function turn(
  persona: NonNullable<ReturnType<typeof personaById>>,
  messages: Msg[],
): Promise<{ calls: ToolCall[]; reply: string; assistant: Msg }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.2,
      messages,
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
  const calls: ToolCall[] = (msg.tool_calls ?? []).map(
    (c: { id: string; function: { name: string; arguments: string } }) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        // A malformed argument blob is the model's problem, not a reason to
        // drop the call: the gateway should still see the attempt.
      }
      return { id: c.id, name: c.function.name, args };
    },
  );
  return { calls, reply: typeof msg.content === 'string' ? msg.content : '', assistant: msg as Msg };
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
        const messages: Msg[] = [
          { role: 'system', content: persona.system },
          { role: 'user', content: task },
        ];

        let attempted = 0;
        let blocked = 0;
        let held = 0;
        let closing = '';

        for (let t = 0; t < MAX_TURNS; t++) {
          emit({ type: 'status', text: t === 0 ? 'reasoning about the request' : 'deciding what to do next' });
          const { calls, reply, assistant } = await turn(persona, messages);

          if (calls.length === 0) {
            closing = reply;
            break;
          }

          emit({ type: 'status', text: `${calls.length} tool call${calls.length > 1 ? 's' : ''} selected` });
          messages.push(assistant);

          for (const call of calls) {
            attempted++;
            emit({ type: 'call', tool: call.name, args: call.args });

            let outcome: string;
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

              // What the agent is told. A refusal has to come back as the tool's
              // result, because that is what actually happens in production: the
              // gateway answers instead of the tool, and the agent has to cope.
              outcome =
                v.decision === 'allow'
                  ? JSON.stringify({ ok: true, note: 'executed against the demo tool server' })
                  : JSON.stringify({
                      ok: false,
                      refusedBy: 'AgentGate',
                      decision: v.decision,
                      reason: v.reasoning,
                      policy: v.violatedPolicy ?? null,
                    });
            } catch (err) {
              // A firewall that cannot answer must not let the call through.
              emit({ type: 'error', tool: call.name, text: (err as Error).message });
              blocked++;
              outcome = JSON.stringify({ ok: false, refusedBy: 'AgentGate', reason: 'the safety check failed to run' });
            }

            messages.push({ role: 'tool', tool_call_id: call.id, content: outcome });
          }
        }

        // The agent's own account. Prefer what the model actually said once it
        // had the verdicts; fall back to a count that cannot overstate them.
        const done = attempted - blocked - held;
        const parts: string[] = [];
        if (done > 0) parts.push(`${done} action${done > 1 ? 's' : ''} completed`);
        if (held > 0) parts.push(`${held} sent for human review`);
        if (blocked > 0) parts.push(`${blocked} refused by AgentGate`);
        emit({
          type: 'reply',
          text:
            closing ||
            (parts.length ? parts.join(', ') + '.' : 'No tool call was needed — nothing reached the firewall.'),
          toolCalls: attempted,
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
