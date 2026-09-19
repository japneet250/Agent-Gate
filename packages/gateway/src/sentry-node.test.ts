import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as Sentry from '@sentry/node';
import { reportError } from './monitoring.js';
import { initSentryNode } from './sentry-node.js';

// Runs the real Sentry SDK against a fake transport, so nothing leaves the machine.
// Secrets are assembled at runtime: Sentry attaches nearby SOURCE lines to error reports, and a literal in this file
// would show up there and look like a leak.
type Envelope = [unknown, [{ type: string }, Record<string, any>][]];
const join = (...p: string[]) => p.join('-');
const GATEWAY_KEY = join('gw', 'key', 'abc123');
const SSN = join('123', '45', '6789');
const LOG_ARG = join('987', '65', '4321');
const CLIENT_IP = ['1', '2', '3', '4'].join('.');

const sent: Envelope[] = [];
const events = () => sent.flatMap((e) => e[1]).filter(([h]) => h.type === 'event').map(([, p]) => p);

describe('Sentry (Node)', () => {
  it('does nothing without a DSN', async () => {
    assert.equal(await initSentryNode({}), false);
  });

  it('with a DSN: reports handled errors with their tag, and leaks no private data', async () => {
    const transport = () => ({ send: async (e: Envelope) => (sent.push(e), {}), flush: async () => true });
    assert.equal(await initSentryNode({ SENTRY_DSN: 'https://abc@o0.ingest.sentry.io/1' }, 'test-runtime', transport), true);

    // 1. a handled error, raised while private values sit in local variables and in a console log line
    const localValue = SSN;
    console.error('[agentgate] intercepted', LOG_ARG); // what AGENTGATE_LOG_ARGS=1 would print
    reportError(new Error('evaluator crashed'), 'http-evaluator');
    void localValue;

    // 2. an event that arrives carrying request data, the gateway key and a client IP
    Sentry.captureEvent({
      message: 'with request data',
      request: { headers: { authorization: `Bearer ${GATEWAY_KEY}` }, data: `body ${SSN}`, url: 'https://x/evaluate' },
      user: { ip_address: CLIENT_IP },
    });
    await Sentry.flush(2000);

    const all = events();
    assert.equal(all.length, 2);

    const err = all.find((e) => e.exception);
    assert.equal(err?.exception.values[0].value, 'evaluator crashed');
    assert.equal(err?.tags.where, 'http-evaluator');
    assert.equal(err?.tags.runtime, 'test-runtime');
    assert.equal(err?.server_name, 'agentgate', 'must not send the machine hostname');

    const msg = all.find((e) => e.message === 'with request data');
    assert.equal(msg?.request, undefined);
    assert.equal(msg?.user, undefined);

    const wire = JSON.stringify(all);
    for (const [what, secret] of [['gateway key', GATEWAY_KEY], ['SSN', SSN], ['console log argument', LOG_ARG], ['client IP', CLIENT_IP]]) {
      assert.ok(!wire.includes(secret), `${what} must not be sent to Sentry`);
    }
    assert.ok(!wire.includes('"authorization"'));
    assert.ok(!JSON.stringify(err?.breadcrumbs ?? []).includes('intercepted'), 'console output must not become breadcrumbs');
  });
});
