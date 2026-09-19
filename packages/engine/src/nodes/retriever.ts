import { enrichQuery } from '../enrich.ts';
import { retrievePolicies } from '../policyStore.ts';
import type { GraphState } from '../state.ts';

/**
 * Turn a tool call into the query we search policies with, annotated with the
 * kinds of sensitive data detected in its arguments so that a raw payload can
 * match policy prose it shares no vocabulary with.
 */
export function toQuery(state: GraphState): string {
  const { toolName, toolArgs } = state.action;
  const payload = JSON.stringify(toolArgs ?? {});
  const base = `Category ${state.category}. Tool "${toolName}" called with arguments: ${payload}`;
  return enrichQuery(base, `${toolName} ${payload}`);
}

export async function retrieverNode(state: GraphState): Promise<Partial<GraphState>> {
  const policies = await retrievePolicies(toQuery(state), {
    category: state.category,
    trace: state.trace,
  });
  return { policies };
}
