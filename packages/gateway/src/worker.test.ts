import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentAction } from '@agentgate/shared';
import { createEvaluator, withAuditLog } from './evaluate.js';
import { createPolicyCache, insertActionLog, type D1Like } from './policies.js';
import { DEFAULT_CONFIG, createRuleEngine } from './rules.js';
import { createWorker } from './worker.js';

// In-memory stand-in for a D1 binding: records writes, answers the policies query.
function fakeDb(disabled: string[] = [], opts: { failReads?: boolean; failWrites?: boolean } = {}) {
  const writes: { sql: string; values: unknown[] }[] = [];
  let reads = 0;
  const db: D1Like = {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: async () => {
          if (opts.failWrites) throw new Error('d1 down');
          writes.push({ sql, values });
        },
      }),
      all: async <T,>() => {
        reads++;
        if (opts.failReads) throw new Error('d1 down');
        return { results: disabled.map((id) => ({ id })) as T[] };
      },
    }),
  };
  return { db, writes, reads: () => reads };
}

const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), settled: () => Promise.allSettled(pending) };
};
const call = (worker: ReturnType<typeof createWorker>, env: Record<string, unknown>, body: unknown, headers: Record<string, string> = {}, c = ctx()) =>
  worker.fetch(new Request('http://x/evaluate', { method: 'POST', headers, body: JSON.stringify(body) }), env, c);

const action = (toolName: string, toolArgs: Record<string, unknown> = {}): AgentAction => ({
  id: 'act-1', agentId: 'bot', toolName, toolArgs, timestamp: new Date('2026-09-19T12:00:00Z'), sessionId: 's1',
});

describe('policies table -> rule switches', () => {
  it('a disabled policy turns its rule off; the others keep working', () => {
    const engine = createRuleEngine(DEFAULT_CONFIG, (name) => name !== 'pii_detector');
    assert.equal(engine.run(action('send_email', { body: 'SSN 123-45-6789' })).matched, false);
    assert.equal(engine.run(action('run_command', { command: 'DROP TABLE users' })).matched, true);
  });

  it('reads disabled ids from D1, caches for the ttl, then refreshes', async () => {
    const { db, reads } = fakeDb(['rate_limit']);
    let t = 0;
    const cache = createPolicyCache(db, 1000, () => t);
    assert.equal(cache.isEnabled('rate_limit'), true, 'everything is on before the first read');
    await cache.refresh();
    assert.equal(cache.isEnabled('rate_limit'), false);
    assert.equal(cache.isEnabled('pii_detector'), true);
    await cache.refresh();
    assert.equal(reads(), 1, 'cached within the ttl');
    t = 1500;
    await cache.refresh();
    assert.equal(reads(), 2);
  });

  it('keeps every rule ON if the first read fails (safe default)', async () => {
    const cache = createPolicyCache(fakeDb([], { failReads: true }).db);
    await cache.refresh();
    assert.equal(cache.isEnabled('pii_detector'), true);
  });
});

describe('audit log', () => {
  it('stores the decision, redacted args and the judge extras, never raw PII', async () => {
    const { db, writes } = fakeDb();
    await insertActionLog(db, action('send_email', { body: 'SSN 123-45-6789', to: 'a@b.com' }), {
      riskScore: 95, decision: 'block', reasoning: 'PII detected: SSN in "body"', violatedPolicy: 'pii_detector', latencyMs: 0.3,
    });
    const { values } = writes[0];
    assert.ok(!JSON.stringify(values).includes('123-45-6789'));
    assert.ok(!JSON.stringify(values).includes('a@b.com'));
    assert.ok(values.includes('["body","to"]'));
    assert.ok(values.includes('{"body":"SSN [SSN]","to":"***@b.com"}'), 'redacted args are stored'); 
    assert.ok(values.includes('block') && values.includes('pii_detector') && values.includes('2026-09-19T12:00:00.000Z'));
    assert.notEqual(values[0], 'act-1', 'the row id is server-generated, not the caller-supplied action id');
    assert.equal(values[1], 'act-1');
  });

  it('records who decided and the engine extras', async () => {
    const { db, writes } = fakeDb();
    await insertActionLog(db, action('upload_file', { destination: 'https://dropbox.com/u/x' }), {
      riskScore: 100, decision: 'block', reasoning: 'unapproved destination', violatedPolicy: 'Agent-Controlled Destinations', latencyMs: 9577,
      category: 'system_modification', retrievedPolicies: [{ name: 'Agent-Controlled Destinations', score: 0.37 }], patternNotes: [], guardrails: [], degraded: false, decidedBy: 'judge',
    });
    const { sql, values } = writes[0];
    for (const col of ['tool_args', 'category', 'degraded', 'decided_by', 'retrieved_policies', 'pattern_notes', 'guardrails']) assert.ok(sql.includes(col), col);
    assert.equal((sql.match(/\?/g) ?? []).length, values.length, 'one placeholder per bound value');
    assert.ok(values.includes('judge') && values.includes('system_modification'));
    assert.ok(values.includes('[{"name":"Agent-Controlled Destinations","score":0.37}]'));
    assert.ok(values.includes(0), 'degraded = 0');
  });

  it('never changes or delays the decision, even if recording fails', async () => {
    const evaluator = withAuditLog(createEvaluator(), async () => {
      throw new Error('disk full');
    });
    assert.equal((await evaluator(action('send_email', { body: 'SSN 123-45-6789' }))).decision, 'block');
    const sync = withAuditLog(createEvaluator(), () => {
      throw new Error('sync boom');
    });
    assert.equal((await sync(action('ping'))).decision, 'allow');
  });
});

describe('Worker', () => {
  it('logs every evaluated action to D1', async () => {
    const { db, writes } = fakeDb();
    const c = ctx();
    const res = await call(createWorker(), { DB: db, AGENTGATE_API_KEY: 'k' }, { toolName: 'send_email', toolArgs: { body: 'SSN 123-45-6789' }, agentId: 'support-bot' }, { authorization: 'Bearer k' }, c);
    assert.equal((await res.json()).decision, 'block');
    await c.settled();
    assert.equal(writes.length, 1);
    assert.ok(writes[0].values.includes('support-bot'));
  });

  it('a dashboard toggle (enabled = 0) switches the rule off', async () => {
    const { db } = fakeDb(['pii_detector']);
    const res = await call(createWorker(), { DB: db, AGENTGATE_API_KEY: 'k' }, { toolName: 'send_email', toolArgs: { body: 'SSN 123-45-6789' } }, { authorization: 'Bearer k' });
    assert.equal((await res.json()).decision, 'allow');
  });

  it('still decides if the D1 write fails', async () => {
    const { db } = fakeDb([], { failWrites: true });
    const c = ctx();
    const res = await call(createWorker(), { DB: db, AGENTGATE_API_KEY: 'k' }, { toolName: 'run_command', toolArgs: { command: 'rm -rf /' } }, { authorization: 'Bearer k' }, c);
    assert.equal((await res.json()).decision, 'block');
    await c.settled();
  });

  it('works without a DB binding', async () => {
    const res = await call(createWorker(), { AGENTGATE_API_KEY: 'k' }, { toolName: 'ping' }, { authorization: 'Bearer k' });
    assert.equal((await res.json()).decision, 'allow');
  });

  it('refuses to run without an API key unless anonymous mode is explicit', async () => {
    const w = createWorker();
    assert.equal((await call(w, {}, { toolName: 'ping' })).status, 503);
    assert.equal((await w.fetch(new Request('http://x/health'), {}, ctx())).status, 200);
    assert.equal((await call(createWorker(), { AGENTGATE_ALLOW_ANONYMOUS: '1' }, { toolName: 'ping' })).status, 200);
  });

  it('rejects a wrong key with 401 and logs nothing', async () => {
    const { db, writes } = fakeDb();
    const res = await call(createWorker(), { DB: db, AGENTGATE_API_KEY: 'k' }, { toolName: 'ping' }, { authorization: 'Bearer nope' });
    assert.equal(res.status, 401);
    assert.equal(writes.length, 0);
  });

  it('reads rule settings from the environment', async () => {
    const res = await call(createWorker(), { AGENTGATE_API_KEY: 'k', AGENTGATE_BLOCKED_TOOLS: 'nuke_*', AGENTGATE_SPEND_LIMIT: '50' }, { toolName: 'nuke_it' }, { authorization: 'Bearer k' });
    assert.equal((await res.json()).violatedPolicy, 'blocked_tool');
  });
});
