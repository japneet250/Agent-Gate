import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createEvaluator, type Evaluator } from './evaluate.js';
import { startHttpServer } from './http.js';

type Started = { url: string; close: () => Promise<void> };
async function start(evaluate: Evaluator, opts: { apiKey?: string; maxBodyBytes?: number } = {}): Promise<Started> {
  const server = await startHttpServer(evaluate, { port: 0, ...opts });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((res) => (server.closeAllConnections(), server.close(() => res()))) };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /evaluate', () => {
  let s: Started;
  before(async () => void (s = await start(createEvaluator())));
  after(() => s.close());

  it('allows a safe action', async () => {
    const res = await post(s.url, { toolName: 'lookup_order', toolArgs: { order_id: '123' }, agentId: 'support-bot' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decision, 'allow');
    assert.equal(typeof body.riskScore, 'number');
    assert.equal(typeof body.latencyMs, 'number');
  });

  it('blocks an SSN with a reason and the policy that fired', async () => {
    const res = await post(s.url, { toolName: 'send_email', toolArgs: { body: 'SSN: 123-45-6789' } });
    assert.equal(res.status, 200); // a "block" is a normal answer, not an HTTP error
    const body = await res.json();
    assert.equal(body.decision, 'block');
    assert.equal(body.violatedPolicy, 'pii_detector');
    assert.match(body.reasoning, /SSN in "body"/);
    assert.ok(!JSON.stringify(body).includes('123-45-6789'));
  });

  it('blocks DROP TABLE and a large refund', async () => {
    const drop = await (await post(s.url, { toolName: 'query_database', toolArgs: { sql: 'DROP TABLE users' } })).json();
    assert.equal(drop.decision, 'block');
    const refund = await (await post(s.url, { toolName: 'issue_refund', toolArgs: { amount: 9000 } })).json();
    assert.equal(refund.decision, 'block');
  });

  it('accepts snake_case field names', async () => {
    const res = await post(s.url, { tool_name: 'run_command', tool_args: { command: 'rm -rf /' }, agent_id: 'coder', session_id: 'x' });
    assert.equal((await res.json()).decision, 'block');
  });

  it('defaults toolArgs to {}', async () => {
    assert.equal((await (await post(s.url, { toolName: 'ping' })).json()).decision, 'allow');
  });

  it('rejects malformed requests with 400 and a message', async () => {
    const bad: [unknown, RegExp][] = [
      ['{not json', /valid JSON/],
      [[], /JSON object/],
      ['null', /JSON object/],
      [{}, /toolName/],
      [{ toolName: '' }, /toolName/],
      [{ toolName: 42 }, /toolName/],
      [{ toolName: 'x', toolArgs: 'nope' }, /toolArgs/],
      [{ toolName: 'x', toolArgs: [1] }, /toolArgs/],
      [{ toolName: 'x'.repeat(201) }, /toolName/],
    ];
    for (const [body, msg] of bad) {
      const res = await post(s.url, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, msg);
    }
  });

  it('answers 404 / 405 for other paths and methods', async () => {
    assert.equal((await fetch(`${s.url}/nope`)).status, 404);
    const get = await fetch(`${s.url}/evaluate`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
  });

  it('serves /health', async () => {
    const res = await fetch(`${s.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('ignores a client-supplied timestamp so it cannot dodge the rate limiter', async () => {
    const seen: Date[] = [];
    const t = await start(async (a) => (seen.push(a.timestamp), { riskScore: 0, decision: 'allow', reasoning: '', latencyMs: 0 }));
    try {
      await post(t.url, { toolName: 'x', timestamp: '1999-01-01T00:00:00Z' });
      assert.ok(Date.now() - seen[0].getTime() < 5000);
    } finally {
      await t.close();
    }
  });

  it('rate-limits per agentId across HTTP calls', async () => {
    const t = await start(createEvaluator());
    try {
      for (let i = 0; i < 20; i++) assert.equal((await (await post(t.url, { toolName: 'ping', agentId: 'noisy' })).json()).decision, 'allow');
      assert.equal((await (await post(t.url, { toolName: 'ping', agentId: 'noisy' })).json()).violatedPolicy, 'rate_limit');
      assert.equal((await (await post(t.url, { toolName: 'ping', agentId: 'calm' })).json()).decision, 'allow');
    } finally {
      await t.close();
    }
  });

  it('answers quickly (rules path)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      await post(s.url, { toolName: 'send_email', toolArgs: { body: 'SSN 123-45-6789' }, agentId: `a${i}` });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`    HTTP round trip: median ${times[25].toFixed(1)}ms, worst ${times[49].toFixed(1)}ms`);
    assert.ok(times[25] < 50);
  });
});

describe('failure handling', () => {
  it('fails closed with a 500 that still says block when the evaluator throws', async () => {
    const t = await start(async () => {
      throw new Error('boom');
    });
    try {
      const res = await post(t.url, { toolName: 'x' });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.decision, 'block');
      assert.ok(!JSON.stringify(body).includes('boom'), 'internal error text must not leak');
    } finally {
      await t.close();
    }
  });

  it('rejects oversized bodies with 413', async () => {
    const t = await start(createEvaluator(), { maxBodyBytes: 1000 });
    try {
      const res = await post(t.url, { toolName: 'x', toolArgs: { blob: 'a'.repeat(5000) } });
      assert.equal(res.status, 413);
    } finally {
      await t.close();
    }
  });
});

describe('API key', () => {
  let s: Started;
  before(async () => void (s = await start(createEvaluator(), { apiKey: 'sekret' })));
  after(() => s.close());

  it('rejects missing or wrong keys with 401', async () => {
    assert.equal((await post(s.url, { toolName: 'x' })).status, 401);
    assert.equal((await post(s.url, { toolName: 'x' }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(s.url, { toolName: 'x' }, { authorization: 'sekret' })).status, 401);
  });

  it('accepts the right key, and leaves /health open', async () => {
    assert.equal((await post(s.url, { toolName: 'x' }, { authorization: 'Bearer sekret' })).status, 200);
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
  });
});
