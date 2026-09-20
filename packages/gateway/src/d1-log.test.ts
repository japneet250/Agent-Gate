import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { D1ActionLog } from './d1-log.js';
import type { ActionLogRow } from './handler.js';

const cfg = { accountId: 'a', apiToken: 't', databaseId: 'd' };
const row = {
  action_id: 'x', created_at: new Date().toISOString(), agent_id: 'a', session_id: 's', tool_name: 'create_purchase_order',
  tool_args: '{}', decision: 'allow', risk_score: 0, reasoning: 'ok', latency_ms: 1,
  zip_facts: JSON.stringify(["vendor 'Acme' is on the approved vendor list"]),
} as unknown as ActionLogRow;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeD1(failWhenColumnMissing: boolean) {
  const sql: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { sql: string };
    sql.push(body.sql);
    const bad = failWhenColumnMissing && body.sql.includes('zip_facts');
    return new Response(
      JSON.stringify(bad ? { success: false, errors: [{ message: 'table action_logs has no column named zip_facts' }] } : { success: true, result: [{ results: [] }] }),
      { status: bad ? 400 : 200 },
    );
  }) as typeof fetch;
  return sql;
}

describe('D1ActionLog and the zip_facts column', () => {
  it('writes the Zip facts when the column exists', async () => {
    const sql = fakeD1(false);
    await new D1ActionLog(cfg).write(row);
    assert.equal(sql.length, 1);
    assert.match(sql[0], /zip_facts/);
  });

  it('still logs, without the facts, when migration 0003 has not been applied', async () => {
    const sql = fakeD1(true);
    await new D1ActionLog(cfg).write(row);
    assert.equal(sql.length, 2, 'one failed attempt, one retry');
    assert.doesNotMatch(sql[1], /zip_facts/);
  });

  it('does not swallow an unrelated D1 error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'database is locked' }] }), { status: 500 })) as typeof fetch;
    await assert.rejects(() => new D1ActionLog(cfg).write(row), /locked/);
  });
});
