import type OpenAI from 'openai';

/**
 * A scriptable stand-in for the OpenAI client. Lets the offline suite test the
 * pipeline's own behaviour — routing, guardrails, patterns, fallbacks — without
 * a key and without testing the model's judgement.
 */

export interface MockHandlers {
  classify?: (args: { tool: string; args: Record<string, any> }) => {
    category: string;
    confidence: number;
  };
  /** Return the raw tool-call payload, so tests can return malformed output on purpose. */
  judge?: (prompt: string) => Record<string, unknown>;
  /** Throw from here to exercise the failure paths. */
  onCall?: (kind: 'classify' | 'judge' | 'embed') => void;
}

export interface MockClient {
  client: OpenAI;
  calls: { kind: string; at: number }[];
}

/** Deterministic bag-of-words embedding, so cosine similarity is genuinely lexical. */
export function fakeEmbed(text: string, dims = 256): number[] {
  const v = new Array(dims).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9$]+/)) {
    if (tok.length < 3) continue;
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % dims] += 1;
  }
  return v;
}

const DEFAULT_CLASSIFY: NonNullable<MockHandlers['classify']> = ({ tool }) => {
  const t = tool.toLowerCase();
  // Mirrors the real classifier's precedence: reads before money words.
  if (/^(lookup|get|read|list|search|fetch|check|query|view)/.test(t))
    return { category: 'data_access', confidence: 0.9 };
  if (/(payment|purchase|refund|transfer|invoice|_order|spend)/.test(t))
    return { category: 'financial', confidence: 0.95 };
  if (/(email|send|notify|webhook|message)/.test(t))
    return { category: 'external_comms', confidence: 0.95 };
  if (/(run_command|exec|write_file|grant|deploy)/.test(t))
    return { category: 'system_modification', confidence: 0.95 };
  return { category: 'other', confidence: 0.6 };
};

/**
 * Crude keyword scorer standing in for the real judge. It reads ONLY the
 * attempted-action block: the retrieved policies quote example SSNs and example
 * SQL, so scanning the whole prompt would score every action off the policy text.
 */
export function actionBlock(prompt: string): string {
  const start = prompt.indexOf('## Attempted action');
  const end = prompt.indexOf('## Retrieved policies');
  return (end > start && start >= 0 ? prompt.slice(start, end) : prompt).toLowerCase();
}

const DEFAULT_JUDGE: NonNullable<MockHandlers['judge']> = (prompt) => {
  const p = actionBlock(prompt);
  if (/\d{3}-\d{2}-\d{4}|drop table|rm -rf|delete from/.test(p)) {
    return { risk_score: 92, reasoning: 'Mock: destructive or PII payload detected.', violated_policy: '' };
  }
  if (/newpayee|"amount": (5|6|7|8|9)\d{3}|unknown vendor/.test(p)) {
    return { risk_score: 55, reasoning: 'Mock: unverifiable financial action.', violated_policy: '' };
  }
  return { risk_score: 8, reasoning: 'Mock: routine read within scope.', violated_policy: '' };
};

export function createMockClient(handlers: MockHandlers = {}): MockClient {
  const calls: { kind: string; at: number }[] = [];
  const classify = handlers.classify ?? DEFAULT_CLASSIFY;
  const judge = handlers.judge ?? DEFAULT_JUDGE;

  const client = {
    chat: {
      completions: {
        async create(params: any) {
          const isClassifier = params.tools?.[0]?.function?.name === 'classify_action';
          const kind = isClassifier ? 'classify' : 'judge';
          calls.push({ kind, at: Date.now() });
          handlers.onCall?.(kind);

          const userMsg = params.messages.find((m: any) => m.role === 'user')?.content ?? '';
          let payload: unknown;
          if (isClassifier) {
            const tool = /tool:\s*(.+)/.exec(userMsg)?.[1]?.trim() ?? '';
            const args = JSON.parse(/args:\s*(\{.*\})/s.exec(userMsg)?.[1] ?? '{}');
            payload = classify({ tool, args });
          } else {
            payload = judge(userMsg);
          }

          return {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      type: 'function',
                      function: {
                        name: params.tools[0].function.name,
                        arguments: JSON.stringify(payload),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          };
        },
      },
    },
    embeddings: {
      async create(params: any) {
        calls.push({ kind: 'embed', at: Date.now() });
        handlers.onCall?.('embed');
        const input: string[] = Array.isArray(params.input) ? params.input : [params.input];
        return {
          data: input.map((t) => ({ embedding: fakeEmbed(t) })),
          usage: { prompt_tokens: 50 },
        };
      },
    },
  } as unknown as OpenAI;

  return { client, calls };
}
