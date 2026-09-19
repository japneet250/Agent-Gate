import { randomUUID } from 'node:crypto';
import type { AgentAction } from '@agentgate/shared';
import { config } from '../src/config.ts';
import { resetBreakers, setOpenAIClient } from '../src/llm.ts';
import { setPolicies } from '../src/policyStore.ts';
import { configureStores, MemorySessionStore, MemoryVectorStore } from '../src/store/index.ts';
import { createMockClient, type MockClient, type MockHandlers } from './mockOpenAI.ts';

export function action(
  toolName: string,
  toolArgs: Record<string, any>,
  sessionId = 'test-session',
): AgentAction {
  return {
    id: randomUUID(),
    agentId: 'test-agent',
    toolName,
    toolArgs,
    timestamp: new Date(),
    sessionId,
  };
}

/** Fresh stores, fresh policy index, fresh breakers, mock client installed. */
export function harness(handlers: MockHandlers = {}): MockClient {
  config.openaiApiKey = 'test-key';
  configureStores({ vectors: new MemoryVectorStore(), sessions: new MemorySessionStore() });
  setPolicies(null);
  resetBreakers();
  const mock = createMockClient(handlers);
  setOpenAIClient(mock.client);
  return mock;
}

export function teardown(): void {
  setOpenAIClient(null);
  setPolicies(null);
  resetBreakers();
}
