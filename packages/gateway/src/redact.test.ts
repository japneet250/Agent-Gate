import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactArgs } from './redact.js';

const parse = (args: Record<string, unknown>) => JSON.parse(redactArgs(args));

describe('redactArgs (what the audit log keeps of tool arguments)', () => {
  it('masks PII inside values, at any depth', () => {
    const out = parse({ body: 'SSN 123-45-6789', to: 'jo@example.com', items: [{ note: 'card 4111 1111 1111 1111' }], card: 4111111111111111 });
    assert.deepEqual(out, { body: 'SSN [SSN]', to: '***@example.com', items: [{ note: 'card [CARD]' }], card: '[CARD]' });
  });

  it('blanks secret-looking keys entirely', () => {
    const out = parse({ password: 'hunter2', api_key: 'sk-abc', Authorization: 'Bearer x', apiToken: 't', path: '/db/customers.sql' });
    assert.deepEqual(out, { password: '[redacted]', api_key: '[redacted]', Authorization: '[redacted]', apiToken: '[redacted]', path: '/db/customers.sql' });
  });

  it('keeps ordinary values so the dashboard can show what the agent tried', () => {
    const out = parse({ path: '/db/customers.sql', destination: 'https://dropbox.com/u/xyz', amount: 400, dryRun: false, note: null });
    assert.deepEqual(out, { path: '/db/customers.sql', destination: 'https://dropbox.com/u/xyz', amount: 400, dryRun: false, note: null });
  });

  it('cuts long strings, huge payloads and deep nesting', () => {
    assert.match(parse({ text: 'a'.repeat(1000) }).text, /^a{300}…\(\+700 chars\)$/);
    const big = parse(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'x'.repeat(200)])));
    assert.equal(big._truncated, true);
    assert.ok(redactArgs(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'x'.repeat(200)]))).length <= 4000);
    let deep: any = 'leaf';
    for (let i = 0; i < 12; i++) deep = { n: deep };
    assert.ok(redactArgs({ deep }).includes('[too deep]'));
  });

  it('never throws on odd input (bigint, empty)', () => {
    assert.equal(redactArgs({}), '{}');
    assert.equal(parse({ big: 10n ** 20n }).big, '100000000000000000000');
  });
});
