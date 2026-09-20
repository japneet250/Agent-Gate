import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAction, Decision, SessionContext } from '@agentgate/shared-types';

export type ScenarioCategory = 'safe' | 'dangerous' | 'ambiguous' | 'cumulative' | 'heldout';

export type Scenario = {
  id: string;
  category: ScenarioCategory;
  expected: Decision;
  description: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Calls that already happened in this session, used to build cumulative context. */
  priorActions?: Array<{ toolName: string; toolArgs: Record<string, unknown> }>;
  /** Explicit override; otherwise derived from priorActions. */
  cumulative?: { spend: number; dataAccessCount: number };
  notes?: string;
};

export type ScenarioFile = {
  version: number;
  description: string;
  counts: Record<ScenarioCategory, number>;
  scenarios: Scenario[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = path.join(here, '..', 'scenarios.json');

export function loadScenarios(file = SCENARIOS_PATH): Scenario[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ScenarioFile;
  return parsed.scenarios;
}

/**
 * Builds the AgentAction + SessionContext a scenario represents.
 *
 * Cumulative totals are derived the same way the demo agents derive them
 * (spend books on approve_payment only), so the harness and the live demo put
 * the engine in the same state.
 */
export function materialise(scenario: Scenario): {
  action: AgentAction;
  context: SessionContext;
} {
  const sessionId = `sess_${scenario.id}`;
  const base = Date.now();

  const recentActions: AgentAction[] = (scenario.priorActions ?? []).map((p, i) => ({
    id: randomUUID(),
    agentId: scenario.agentId,
    toolName: p.toolName,
    toolArgs: p.toolArgs,
    timestamp: base - (scenario.priorActions!.length - i) * 1000,
    sessionId,
  }));

  const derived = recentActions.reduce(
    (acc, a) => {
      const amount = a.toolArgs.amount;
      if (a.toolName === 'approve_payment' && typeof amount === 'number') acc.spend += amount;
      if (a.toolName === 'lookup_customer' || a.toolName === 'query_database')
        acc.dataAccessCount += 1;
      return acc;
    },
    { spend: 0, dataAccessCount: 0 },
  );

  return {
    action: {
      id: randomUUID(),
      agentId: scenario.agentId,
      toolName: scenario.toolName,
      toolArgs: scenario.toolArgs,
      timestamp: base,
      sessionId,
    },
    context: {
      sessionId,
      recentActions,
      cumulative: scenario.cumulative ?? derived,
    },
  };
}
