import type { ActionCategory } from '@agentgate/shared';
import { config, hasOpenAI } from '../config.ts';
import { openai, withTimeout } from '../llm.ts';
import type { GraphState } from '../state.ts';

const CATEGORIES: ActionCategory[] = [
  'data_access',
  'external_comms',
  'financial',
  'system_modification',
  'other',
];

const SYSTEM = `You classify AI agent tool calls for a runtime security firewall.
Pick exactly one category:
- data_access: reading, querying, exporting, or listing stored data
- external_comms: sending anything outside the org (email, SMS, webhook, third-party API)
- financial: money movement — payments, purchase orders, refunds, transfers, budgets
- system_modification: shell commands, schema/infra changes, permissions, writing files
- other: anything else
Also give confidence 0-1.`;

const TOOL = {
  type: 'function' as const,
  function: {
    name: 'classify_action',
    description: 'Return the category of the agent action.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORIES },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['category', 'confidence'],
      additionalProperties: false,
    },
  },
};

/** Cheap deterministic guess, used as a fallback and as a prior. */
export function heuristicCategory(toolName: string, args: Record<string, any>): ActionCategory {
  const t = toolName.toLowerCase();
  const blob = JSON.stringify(args ?? {}).toLowerCase();
  if (/(pay|purchase|refund|invoice|budget|order|transfer|charge|payout)/.test(t)) return 'financial';
  if (/(email|sms|slack|webhook|notify|send|post_message|publish)/.test(t)) return 'external_comms';
  if (/(run_command|exec|shell|write_file|deploy|migrate|grant|chmod|iam|delete_)/.test(t))
    return 'system_modification';
  if (/(query|lookup|get|read|list|search|fetch|export)/.test(t)) {
    return /(drop|truncate|alter|delete from|update )/.test(blob) ? 'system_modification' : 'data_access';
  }
  return 'other';
}

export async function classifierNode(state: GraphState): Promise<Partial<GraphState>> {
  const fallback = heuristicCategory(state.action.toolName, state.action.toolArgs);
  if (!hasOpenAI()) return { category: fallback, categoryConfidence: 0.4 };

  try {
    const res = await withTimeout(
      openai().chat.completions.create({
        model: config.classifierModel,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `tool: ${state.action.toolName}\nargs: ${JSON.stringify(state.action.toolArgs)}`,
          },
        ],
        tools: [TOOL],
        tool_choice: { type: 'function', function: { name: 'classify_action' } },
      }),
      config.latencyBudgetMs,
      'classifier',
    );

    const call = res.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== 'function') return { category: fallback, categoryConfidence: 0.4 };
    const parsed = JSON.parse(call.function.arguments) as {
      category: ActionCategory;
      confidence: number;
    };
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : fallback;
    return { category, categoryConfidence: parsed.confidence ?? 0.5 };
  } catch (err) {
    console.warn('[agentgate] classifier failed, using heuristic:', err);
    return { category: fallback, categoryConfidence: 0.4 };
  }
}
