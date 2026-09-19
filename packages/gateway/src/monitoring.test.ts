import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AgentAction, EvalResult } from '@agentgate/shared';
import { createEngineJudge } from './engine.js';
import { withAuditLog } from './evaluate.js';
import { handleRequest } from './handler.js';
import { decisionBreadcrumb, reportError, scrubEvent, setMonitor, type Monitor } from './monitoring.js';

const action: AgentAction = {
  id: 'a1', agentId: 'support-bot', toolName: 'send_email', toolArgs: { body: 'SSN 123-45-6789', to: 'jo@example.com' },
  timestamp: new Date(), sessionId: 's1',
};
const result: EvalResult = { riskScore: 95, decision: 'block', reasoning: 'PII detected: SSN in "body"', violatedPolicy: 'pii_detector', latencyMs: 1 };

function recorder() {
  const errors: { err: unknown; tags?: Record<string, string> }[] = [];
  const crumbs: { category: string; message: string; data?: Record<string, unknown> }[] = [];
  const m: Monitor = { captureException: (err, ctx) => void errors.push({ err, tags: ctx?.tags }), addBreadcrumb: (c) => void crumbs.push(c) };
  setMonitor(m);
  return { errors, crumbs };
}
afterEach(() => setMonitor(undefined));

describe('monitoring hooks', () => {
  it('are harmless no-ops when no monitor is set', () => {
    reportError(new Error('x'), 'somewhere');
    decisionBreadcrumb(action, result);
  });

  it('never let a broken monitor break a decision', () => {
    setMonitor({ captureException: () => { throw new Error('sentry down'); }, addBreadcrumb: () => { throw new Error('sentry down'); } });
    reportError(new Error('x'), 'somewhere');
    decisionBreadcrumb(action, result);
  });

  it('decision breadcrumbs carry the decision but never the arguments', () => {
    const { crumbs } = recorder();
    decisionBreadcrumb(action, result);
    assert.equal(crumbs.length, 1);
    assert.equal(crumbs[0].message, 'send_email -> block');
    assert.deepEqual(crumbs[0].data, { agent: 'support-bot', session: 's1', risk: 95, policy: 'pii_detector' });
    const all = JSON.stringify(crumbs);
    assert.ok(!all.includes('123-45-6789') && !all.includes('jo@example.com'));
  });

  it('scrubEvent removes the request (body, Authorization header, cookies) and the user', () => {
    const event = scrubEvent({
      message: 'boom',
      request: { url: 'https://x/evaluate?k=1', headers: { authorization: 'Bearer secret-key' }, data: '{"toolArgs":{"body":"SSN 123-45-6789"}}', cookies: { a: 'b' } },
      user: { ip_address: '1.2.3.4' },
    });
    assert.deepEqual(Object.keys(event), ['message']);
  });
});

describe('errors are reported where the code fails closed', () => {
  it('HTTP evaluator crash -> tagged http-evaluator, and the caller still gets a block', async () => {
    const { errors } = recorder();
    const res = await handleRequest(
      new Request('http://x/evaluate', { method: 'POST', body: JSON.stringify({ toolName: 'x' }) }),
      async () => { throw new Error('boom'); },
    );
    assert.equal(res.status, 500);
    assert.equal(errors.length, 1);
    assert.deepEqual(errors[0].tags, { where: 'http-evaluator' });
  });

  it('a failed audit-log write -> tagged audit-log, decision unchanged', async () => {
    const { errors } = recorder();
    const evaluate = withAuditLog(async () => result, async () => { throw new Error('d1 down'); });
    assert.equal((await evaluate(action)).decision, 'block');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(errors.map((e) => e.tags), [{ where: 'audit-log' }]);
  });

  it('an unreachable AI judge -> tagged judge', async () => {
    const { errors } = recorder();
    const judge = createEngineJudge({ url: 'http://127.0.0.1:1', timeoutMs: 1000 });
    assert.equal((await judge(action)).decision, 'escalate');
    assert.deepEqual(errors.map((e) => e.tags), [{ where: 'judge' }]);
    assert.match(String((errors[0].err as Error).message), /AI judge unavailable/);
  });

  it('a successful evaluation leaves a breadcrumb and no error', async () => {
    const { errors, crumbs } = recorder();
    await handleRequest(new Request('http://x/evaluate', { method: 'POST', body: JSON.stringify({ toolName: 'ping' }) }), async () => result);
    assert.equal(errors.length, 0);
    assert.equal(crumbs.length, 1);
  });
});
