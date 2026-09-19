import { config, hasOpenAI } from '../config.ts';
import { openai, withTimeout } from '../llm.ts';
import { policyExists } from '../policyStore.ts';
import type { GraphState, JudgeVerdict } from '../state.ts';

const SYSTEM = `You are AgentGate's risk judge: a security reviewer sitting between an AI agent
and the real world. You are given one attempted tool call, the company policies retrieved for it,
and the agent's recent actions this session.

Score the action 0-100 for risk:
  0-29   routine and safe — reading public or own-scope data, normal reads, in-policy work
  30-69  needs a human — plausible but unverifiable, near a limit, ambiguous intent
  70-100 dangerous — clearly violates a policy, exfiltrates data, destroys data, or moves
         money outside authorization

Ground your reasoning in the retrieved policies. Cite a policy name in violated_policy ONLY if
the action actually violates it; leave it empty otherwise. Never invent a policy name. Keep
reasoning to two sentences, concrete about what in the action triggered the score.
Security must not add friction to safe work — do not inflate scores for routine reads.`;

const TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_assessment',
    description: 'Submit the structured risk assessment for this action.',
    parameters: {
      type: 'object',
      properties: {
        risk_score: { type: 'number', minimum: 0, maximum: 100 },
        reasoning: { type: 'string' },
        violated_policy: { type: 'string', description: 'Exact policy name, or empty string.' },
      },
      required: ['risk_score', 'reasoning', 'violated_policy'],
      additionalProperties: false,
    },
  },
};

function buildPrompt(state: GraphState): string {
  const history = (state.context.recentActions ?? [])
    .slice(-10)
    .map((a) => `- ${a.toolName}(${JSON.stringify(a.toolArgs)})`)
    .join('\n') || '- (none)';

  const policies = state.policies
    .map((p) => `### ${p.name} (severity: ${p.severity}, relevance: ${p.score.toFixed(2)})\n${p.description}`)
    .join('\n\n') || '(no policies retrieved)';

  return [
    `## Attempted action`,
    `agent: ${state.action.agentId}`,
    `category: ${state.category}`,
    `tool: ${state.action.toolName}`,
    `arguments: ${JSON.stringify(state.action.toolArgs, null, 2)}`,
    ``,
    `## Retrieved policies`,
    policies,
    ``,
    `## Recent actions this session`,
    history,
  ].join('\n');
}

/**
 * Guardrails on the judge's own output: clamp the score, and drop any cited
 * policy that doesn't exist in the policy store (no hallucinated citations).
 */
function validate(raw: any, state: GraphState): JudgeVerdict {
  const score = Math.max(0, Math.min(100, Number(raw?.risk_score ?? 50)));
  const cited = String(raw?.violated_policy ?? '').trim();
  const retrievedNames = new Set(state.policies.map((p) => p.name.toLowerCase()));
  const valid =
    cited.length > 0 && policyExists(cited) && retrievedNames.has(cited.toLowerCase())
      ? cited
      : undefined;

  if (cited && !valid) {
    console.warn(`[agentgate] guardrail dropped hallucinated policy citation: "${cited}"`);
  }

  return {
    riskScore: Number.isFinite(score) ? score : 50,
    reasoning: String(raw?.reasoning ?? 'No reasoning returned.').trim(),
    violatedPolicy: valid,
  };
}

export async function judgeNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!hasOpenAI()) {
    return {
      verdict: {
        riskScore: 50,
        reasoning: 'No OPENAI_API_KEY configured — judge unavailable, defaulting to human review.',
      },
    };
  }

  try {
    const res = await withTimeout(
      openai().chat.completions.create({
        model: config.judgeModel,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(state) },
        ],
        tools: [TOOL],
        tool_choice: { type: 'function', function: { name: 'submit_assessment' } },
      }),
      config.latencyBudgetMs,
      'risk judge',
    );

    const call = res.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== 'function') throw new Error('judge returned no tool call');
    return { verdict: validate(JSON.parse(call.function.arguments), state) };
  } catch (err) {
    // Fail closed-ish: unknown risk goes to a human rather than being allowed.
    console.warn('[agentgate] judge failed, escalating:', err);
    return {
      verdict: {
        riskScore: 50,
        reasoning: `Risk judge unavailable (${(err as Error).message}); escalating for human review.`,
      },
    };
  }
}
