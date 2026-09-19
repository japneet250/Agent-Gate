import { Langfuse } from 'langfuse';
import { config } from './config.ts';

let client: Langfuse | null = null;
if (config.langfuse.publicKey && config.langfuse.secretKey) {
  client = new Langfuse({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.baseUrl,
  });
}

export interface Span {
  end(output?: unknown): void;
}

const noopSpan: Span = { end() {} };

export interface Trace {
  span(name: string, input?: unknown): Span;
  end(output?: unknown): void;
}

/**
 * One trace per evaluation, one span per LangGraph node. Falls back to a no-op
 * when LangFuse keys are absent so local dev never needs them.
 */
export function startTrace(name: string, input: unknown, sessionId?: string): Trace {
  if (!client) return { span: () => noopSpan, end() {} };
  const trace = client.trace({ name, input, sessionId });
  return {
    span(spanName, spanInput) {
      const s = trace.span({ name: spanName, input: spanInput });
      return { end: (output) => s.end({ output }) };
    },
    end(output) {
      trace.update({ output });
    },
  };
}

/** Call before process exit so buffered traces are delivered. */
export async function flushTraces(): Promise<void> {
  await client?.flushAsync();
}
