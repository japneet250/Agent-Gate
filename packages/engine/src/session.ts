import type { AgentAction } from '@agentgate/shared';

export interface SessionState {
  sessionId: string;
  totalSpend: number;
  actionCounts: Record<string, number>;
  dataAccessCount: number;
  permissionRequests: number;
  lastActions: { toolName: string; argsKey: string; at: number }[];
}

/**
 * In-memory session store. Swap for D1 / Durable Objects when the gateway moves
 * to Cloudflare — only `getSession` and `recordAction` need to change.
 */
const sessions = new Map<string, SessionState>();

export function getSession(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      totalSpend: 0,
      actionCounts: {},
      dataAccessCount: 0,
      permissionRequests: 0,
      lastActions: [],
    };
    sessions.set(sessionId, s);
  }
  return s;
}

export function resetSessions(): void {
  sessions.clear();
}

const AMOUNT_KEYS = ['amount', 'total', 'price', 'value', 'cost', 'sum'];

/** Pull a currency amount out of arbitrary tool args. */
export function extractAmount(args: Record<string, any>): number {
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!AMOUNT_KEYS.some((key) => k.toLowerCase().includes(key))) continue;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function argsKey(args: Record<string, any>): string {
  return JSON.stringify(Object.keys(args ?? {}).sort());
}

export function recordAction(session: SessionState, action: AgentAction, spend: number): void {
  session.totalSpend += spend;
  session.actionCounts[action.toolName] = (session.actionCounts[action.toolName] ?? 0) + 1;
  session.lastActions.push({
    toolName: action.toolName,
    argsKey: argsKey(action.toolArgs),
    at: Date.now(),
  });
  if (session.lastActions.length > 50) session.lastActions.shift();
}
