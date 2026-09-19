import type { ActionCategory } from '@agentgate/shared';
import { config, hasOpenAI } from '../config.ts';
import { guardedCall, openai, usageOf } from '../llm.ts';
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
- system_modification: shell commands, schema or infra changes, permissions, writing files
- other: anything else
Judge by what the call actually does, not by what it is named.
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

/**
 * Deterministic guess, used as the fallback whenever the model is unavailable.
 * Order matters: a destructive payload outranks the tool's name, and read verbs
 * are checked before money words so `lookup_order` is a read, not a purchase.
 */
export function heuristicCategory(toolName: string, args: Record<string, any>): ActionCategory {
  const t = toolName.toLowerCase();
  const blob = JSON.stringify(args ?? {}).toLowerCase();

  // What the call carries beats what it is called.
  if (/(drop\s+table|truncate|alter\s+table|delete\s+from|rm\s+-rf|mkfs|chmod)/.test(blob)) {
    return 'system_modification';
  }
  if (/^(lookup|get|read|list|search|fetch|find|describe|check|query|view|show)/.test(t)) {
    return 'data_access';
  }
  if (/(payment|purchase|refund|invoice|transfer|charge|payout|billing|_order|order_|spend|budget)/.test(t)) {
    return 'financial';
  }
  if (/(email|sms|slack|webhook|notify|send|post_message|publish|message|dispatch)/.test(t)) {
    return 'external_comms';
  }
  if (/(run_command|exec|shell|write_file|deploy|migrate|grant|revoke|iam|provision|delete|create|update|modify)/.test(t)) {
    return 'system_modification';
  }
  return 'other';
}

export async function classifierNode(state: GraphState): Promise<Partial<GraphState>> {
  const fallback = heuristicCategory(state.action.toolName, state.action.toolArgs);
  if (!hasOpenAI()) return { category: fallback, categoryConfidence: 0.4, degraded: true };

  const input = { tool: state.action.toolName, args: state.action.toolArgs };
  const gen = state.trace.generation('classifier.llm', config.classifierModel, input);

  try {
    const res = await guardedCall(
      () =>
        openai().chat.completions.create({
          model: config.classifierModel,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `tool: ${state.action.toolName}\nargs: ${JSON.stringify(state.action.toolArgs)}` },
          ],
          tools: [TOOL],
          tool_choice: { type: 'function', function: { name: 'classify_action' } },
        }),
      { label: 'classifier', timeoutMs: config.classifierTimeoutMs },
    );

    const call = res.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== 'function') throw new Error('no tool call returned');

    const parsed = JSON.parse(call.function.arguments) as { category: ActionCategory; confidence: number };
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : fallback;
    const confidence = Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5;

    gen.end({ category, confidence }, usageOf(config.classifierModel, res.usage));
    return { category, categoryConfidence: confidence };
  } catch (err) {
    gen.end({ error: (err as Error).message, fallback });
    console.warn('[agentgate] classifier degraded to heuristic:', (err as Error).message);
    return { category: fallback, categoryConfidence: 0.4, degraded: true };
  }
}
