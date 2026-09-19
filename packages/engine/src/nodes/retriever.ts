import { retrievePolicies } from '../policyStore.ts';
import type { GraphState } from '../state.ts';

/** Turn a tool call into the natural-language query we search policies with. */
function toQuery(state: GraphState): string {
  const { toolName, toolArgs } = state.action;
  return `Agent category ${state.category}. Tool "${toolName}" called with arguments: ${JSON.stringify(
    toolArgs,
  )}`;
}

export async function retrieverNode(state: GraphState): Promise<Partial<GraphState>> {
  const policies = await retrievePolicies(toQuery(state), { category: state.category });
  return { policies };
}
