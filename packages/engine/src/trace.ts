import { Langfuse } from 'langfuse';
import { config } from './config.ts';
import type { Usage } from './llm.ts';

let client: Langfuse | null = null;
if (config.langfuse.publicKey && config.langfuse.secretKey) {
  client = new Langfuse({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.baseUrl,
  });
}

export const tracingEnabled = () => client !== null;

export interface Span {
  end(output?: unknown): void;
}

export interface Generation {
  end(output: unknown, usage?: Usage): void;
}

const noopSpan: Span = { end() {} };
const noopGeneration: Generation = { end() {} };

export interface Trace {
  span(name: string, input?: unknown): Span;
  /** An LLM call specifically — carries model, tokens and cost in LangFuse. */
  generation(name: string, model: string, input: unknown): Generation;
  event(name: string, payload: unknown): void;
  end(output?: unknown): void;
}

export const noopTrace: Trace = {
  span: () => noopSpan,
  generation: () => noopGeneration,
  event() {},
  end() {},
};

/** One trace per evaluation; one span per node; one generation per LLM call. */
export function startTrace(name: string, input: unknown, sessionId?: string): Trace {
  if (!client) return noopTrace;
  const trace = client.trace({ name, input, sessionId });

  return {
    span(spanName, spanInput) {
      const s = trace.span({ name: spanName, input: spanInput });
      return { end: (output) => s.end({ output }) };
    },
    generation(genName, model, genInput) {
      const g = trace.generation({ name: genName, model, input: genInput });
      return {
        end(output, usage) {
          g.end({
            output,
            usageDetails: usage
              ? { input: usage.promptTokens, output: usage.completionTokens }
              : undefined,
            costDetails: usage ? { total: usage.costUsd } : undefined,
          });
        },
      };
    },
    event(eventName, payload) {
      trace.event({ name: eventName, input: payload });
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
