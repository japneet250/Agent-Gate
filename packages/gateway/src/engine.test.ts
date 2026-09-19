import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { AgentAction } from '@agentgate/shared';
import { createEngineJudge, judgeFromEnv, parseEngineResult } from './engine.js';
import { createEvaluator } from './evaluate.js';
import { DEFAULT_CONFIG } from './rules.js';

const action = (toolName: string, toolArgs: Record<string, unknown> = {}): AgentAction => ({
  id: 'act-1', agentId: 'support-bot', toolName, toolArgs, timestamp: new Date('2026-09-19T12:00:00Z'), sessionId: 'sess-9',
});

// A throwaway fake engine on a random port. `reply` decides the response for each request.
async function fakeEngine(reply: (body: any, req: { method?: string; url?: string }) => { status?: number; body?: unknown; raw?: string; delayMs?: number }) {
  const seen: any[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const parsed = raw ? JSON.parse(raw) : {};
      seen.push(parsed);
      const r = reply(parsed, req);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  };
}

describe('AI judge client', () => {
  it('sends { action, context } in camelCase (Person 2\'s documented format) and returns the verdict', async () => {
    const e = await fakeEngine(() => ({ body: { riskScore: 82, decision: 'block', reasoning: 'looks like exfiltration', violatedPolicy: 'data_leak', latencyMs: 310 } }));
    try {
      const r = await createEngineJudge({ url: e.url })(action('export_data', { table: 'users' }));
      assert.deepEqual(r, { riskScore: 82, decision: 'block', reasoning: 'looks like exfiltration', violatedPolicy: 'data_leak', latencyMs: 310 });
      assert.deepEqual(e.seen[0], {
        action: { id: 'act-1', agentId: 'support-bot', toolName: 'export_data', toolArgs: { table: 'users' }, sessionId: 'sess-9', timestamp: '2026-09-19T12:00:00.000Z' },
        context: { sessionId: 'sess-9', agentId: 'support-bot' },
      });
    } finally {
      await e.close();
    }
  });

  it('also understands a snake_case reply, and a trailing slash on the URL', async () => {
    const e = await fakeEngine((_b, req) => ({ status: req.url === '/evaluate' ? 200 : 404, body: { risk_score: 55, decision: 'escalate', reasoning: 'hmm', violated_policy: 'p1', latency_ms: 12 } }));
    try {
      const r = await createEngineJudge({ url: `${e.url}/` })(action('x'));
      assert.deepEqual(r, { riskScore: 55, decision: 'escalate', reasoning: 'hmm', violatedPolicy: 'p1', latencyMs: 12 });
    } finally {
      await e.close();
    }
  });

  it('ignores the engine\'s extra fields and flags a degraded verdict', async () => {
    const e = await fakeEngine(() => ({ body: { riskScore: 50, decision: 'escalate', reasoning: 'model down', latencyMs: 20, category: 'financial', retrievedPolicies: [{ name: 'p', score: 0.4 }], patternNotes: [], guardrails: [], degraded: true } }));
    try {
      const r = await createEngineJudge({ url: e.url })(action('x'));
      assert.deepEqual(r, { riskScore: 50, decision: 'escalate', reasoning: '[degraded] model down', latencyMs: 20 });
    } finally {
      await e.close();
    }
  });

  it('waits longer than the engine\'s own 25s judge timeout by default', async () => {
    const judge = createEngineJudge({
      url: 'http://engine.test',
      fetch: async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
    });
    assert.match((await judge(action('x'))).reasoning, /timed out after 30000ms/);
  });

  it('derives the decision from the score if the engine leaves it out, and fills in missing fields', async () => {
    const e = await fakeEngine(() => ({ body: { risk_score: 10 } }));
    try {
      const r = await createEngineJudge({ url: e.url })(action('x'));
      assert.equal(r.decision, 'allow');
      assert.equal(r.reasoning, 'AI judge gave no reasoning');
      assert.equal(r.violatedPolicy, undefined);
      assert.ok(r.latencyMs >= 0);
    } finally {
      await e.close();
    }
  });

  describe('when the judge cannot answer, it fails safe (escalate = blocked by default)', () => {
    const cases: [string, () => Promise<{ url: string; close: () => Promise<void> }>, RegExp][] = [
      ['HTTP 500', () => fakeEngine(() => ({ status: 500, body: { detail: 'boom' } })), /HTTP 500/],
      ['not JSON', () => fakeEngine(() => ({ raw: '<html>oops</html>' })), /not JSON/],
      ['missing risk score', () => fakeEngine(() => ({ body: { decision: 'allow' } })), /not a valid result/],
      ['score out of range', () => fakeEngine(() => ({ body: { risk_score: 500, decision: 'allow' } })), /not a valid result/],
      ['unknown decision', () => fakeEngine(() => ({ body: { risk_score: 5, decision: 'maybe' } })), /not a valid result/],
      ['array body', () => fakeEngine(() => ({ body: [1, 2] })), /not a valid result/],
    ];
    for (const [name, start, msg] of cases) {
      it(name, async () => {
        const e = await start();
        try {
          const r = await createEngineJudge({ url: e.url })(action('x'));
          assert.equal(r.decision, 'escalate');
          assert.equal(r.violatedPolicy, 'judge_unavailable');
          assert.match(r.reasoning, msg);
        } finally {
          await e.close();
        }
      });
    }

    it('engine down (connection refused)', async () => {
      const e = await fakeEngine(() => ({}));
      const url = e.url;
      await e.close();
      const r = await createEngineJudge({ url, timeoutMs: 2000 })(action('x'));
      assert.equal(r.decision, 'escalate');
      assert.match(r.reasoning, /unreachable/);
    });

    it('timeout', async () => {
      const e = await fakeEngine(() => ({ delayMs: 500, body: { risk_score: 0, decision: 'allow' } }));
      try {
        const t = performance.now();
        const r = await createEngineJudge({ url: e.url, timeoutMs: 80 })(action('x'));
        assert.match(r.reasoning, /timed out after 80ms/);
        assert.ok(performance.now() - t < 450, 'must not wait for the slow engine');
      } finally {
        await e.close();
      }
    });

    it('onError can be set to allow or block', async () => {
      const e = await fakeEngine(() => ({ status: 500 }));
      try {
        assert.equal((await createEngineJudge({ url: e.url, onError: 'allow' })(action('x'))).decision, 'allow');
        const blocked = await createEngineJudge({ url: e.url, onError: 'block' })(action('x'));
        assert.equal(blocked.decision, 'block');
        assert.equal(blocked.riskScore, 90);
      } finally {
        await e.close();
      }
    });
  });
});

describe('judge wired into the evaluator', () => {
  it('rules first: a rule match never reaches the engine, so PII stays in the gateway', async () => {
    const e = await fakeEngine(() => ({ body: { risk_score: 5, decision: 'allow', reasoning: 'fine' } }));
    try {
      const evaluate = createEvaluator(DEFAULT_CONFIG, createEngineJudge({ url: e.url }));
      const r = await evaluate(action('send_email', { body: 'SSN 123-45-6789' }));
      assert.equal(r.decision, 'block');
      assert.equal(e.seen.length, 0, 'the engine must not see rule-blocked calls');
      assert.ok(!JSON.stringify(e.seen).includes('123-45-6789'));
    } finally {
      await e.close();
    }
  });

  it('a call no rule catches is decided by the engine', async () => {
    const e = await fakeEngine(() => ({ body: { risk_score: 88, decision: 'block', reasoning: 'judge: suspicious pattern' } }));
    try {
      const evaluate = createEvaluator(DEFAULT_CONFIG, createEngineJudge({ url: e.url }));
      const r = await evaluate(action('export_customers', { format: 'csv' }));
      assert.equal(r.decision, 'block');
      assert.equal(r.reasoning, 'judge: suspicious pattern');
      assert.equal(e.seen.length, 1);
    } finally {
      await e.close();
    }
  });
});

describe('configuration', () => {
  it('no ENGINE_URL means no judge', () => {
    assert.equal(judgeFromEnv({}), undefined);
  });

  it('reads ENGINE_URL, timeout and on-error from the environment', async () => {
    const e = await fakeEngine(() => ({ status: 500 }));
    try {
      const judge = judgeFromEnv({ ENGINE_URL: e.url, AGENTGATE_JUDGE_ON_ERROR: 'block', AGENTGATE_JUDGE_TIMEOUT_MS: 'abc' });
      assert.equal((await judge!(action('x'))).decision, 'block');
    } finally {
      await e.close();
    }
  });

  it('parseEngineResult rejects junk', () => {
    for (const junk of [null, 'x', 5, [], {}, { risk_score: 'high' }, { risk_score: -1 }, { risk_score: NaN }]) {
      assert.equal(parseEngineResult(junk, 1), undefined, JSON.stringify(junk));
    }
  });
});
