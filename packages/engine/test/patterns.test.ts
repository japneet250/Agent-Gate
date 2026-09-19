import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { fingerprint } from '../src/guardrails.ts';
import { evaluateDetailed } from '../src/index.ts';
import { action, harness, teardown } from './helpers.ts';

afterEach(teardown);

/** A $400 purchase order — individually well under the $500 approval threshold. */
const po = (n: number, session = 'procurement') =>
  action('approve_payment', { vendor: `Vendor ${n}`, amount: 400, poNumber: `PO-${n}` }, session);

describe('action fingerprint', () => {
  it('ignores key order but not values', () => {
    assert.equal(
      fingerprint('t', { a: 1, b: 2 }),
      fingerprint('t', { b: 2, a: 1 }),
      'key order must not change identity',
    );
    assert.notEqual(
      fingerprint('approve_payment', { vendor: 'Acme' }),
      fingerprint('approve_payment', { vendor: 'Globex' }),
      'different vendors are different actions, not a loop',
    );
  });
});

describe('cumulative spend detection', () => {
  it('allows each $400 order until the session total crosses $5,000', async () => {
    harness();
    const results = [];
    for (let i = 1; i <= 20; i++) results.push(await evaluateDetailed(po(i)));

    // 12 x $400 = $4,800 is under the limit; the 13th tips it over.
    const firstFlagged = results.findIndex((r) => r.decision !== 'allow');
    assert.equal(firstFlagged, 12, `expected the 13th order to flag, got #${firstFlagged + 1}`);

    assert.ok(
      results.slice(0, 12).every((r) => r.decision === 'allow'),
      'individually-safe orders must pass without friction',
    );

    const flagged = results[12];
    assert.equal(flagged.decision, 'escalate');
    assert.match(flagged.reasoning, /Cumulative spend alert/);
    assert.match(flagged.reasoning, /approval-threshold splitting/);
    assert.equal(flagged.violatedPolicy, 'Cumulative Spending Limit');
    assert.ok(flagged.riskScore >= 75);
  });

  it('keeps sessions isolated', async () => {
    harness();
    for (let i = 1; i <= 20; i++) await evaluateDetailed(po(i, 'session-a'));
    const other = await evaluateDetailed(po(1, 'session-b'));
    assert.equal(other.decision, 'allow', 'one agent’s spend must not taint another session');
  });

  it('does not count spend from actions it did not allow', async () => {
    harness({ judge: () => ({ risk_score: 95, reasoning: 'blocked', violated_policy: '' }) });
    for (let i = 1; i <= 20; i++) await evaluateDetailed(po(i));
    const r = await evaluateDetailed(po(99));
    // Everything was blocked, so nothing was ever spent — no cumulative alert.
    assert.ok(!/Cumulative spend alert/.test(r.reasoning), r.reasoning);
  });
});

describe('loop detection', () => {
  it('flags the identical call repeated past the limit', async () => {
    harness();
    let flaggedAt = 0;
    for (let i = 1; i <= config.repeatedCallLimit + 3; i++) {
      const r = await evaluateDetailed(
        action('lookup_customer', { customerId: 'C-1' }, 'loop-session'),
      );
      if (/Repetition alert/.test(r.reasoning) && !flaggedAt) flaggedAt = i;
    }
    assert.equal(flaggedAt, config.repeatedCallLimit + 1);
  });

  it('does not flag the same tool called with different arguments', async () => {
    harness();
    for (let i = 1; i <= config.repeatedCallLimit + 3; i++) {
      const r = await evaluateDetailed(
        action('lookup_customer', { customerId: `C-${i}` }, 'varied-session'),
      );
      assert.ok(!/Repetition alert/.test(r.reasoning), `flagged at #${i}: ${r.reasoning}`);
    }
  });
});

describe('privilege escalation detection', () => {
  it('escalates after repeated permission-related calls', async () => {
    harness();
    let flagged;
    for (let i = 1; i <= config.permissionRequestLimit; i++) {
      flagged = await evaluateDetailed(action('grant_role', { role: `role-${i}` }, 'priv-session'));
    }
    assert.match(flagged!.reasoning, /Privilege escalation alert/);
    assert.notEqual(flagged!.decision, 'allow');
  });
});

describe('consistency guardrail', () => {
  it('takes the stricter score when the identical action scores inconsistently', async () => {
    let call = 0;
    harness({
      judge: () => {
        call++;
        // Same action, wildly different scores — an inconsistent judge.
        return { risk_score: call === 1 ? 80 : 5, reasoning: 'mock', violated_policy: '' };
      },
    });
    const a = action('issue_refund', { customerId: 'C-1', amount: 300 }, 'consistency');
    const first = await evaluateDetailed(a);
    const second = await evaluateDetailed({ ...a, id: 'second' });

    assert.equal(first.riskScore, 80);
    assert.equal(second.riskScore, 80, 'the inconsistent low score must not win');
    assert.ok(second.guardrails.some((g) => g.rule === 'consistency'), 'guardrail should be recorded');
    assert.notEqual(second.decision, 'allow');
  });

  it('leaves genuinely different actions alone', async () => {
    let call = 0;
    harness({
      judge: () => {
        call++;
        return { risk_score: call === 1 ? 80 : 5, reasoning: 'mock', violated_policy: '' };
      },
    });
    await evaluateDetailed(action('send_email', { body: 'SSN 123-45-6789' }, 's'));
    const benign = await evaluateDetailed(action('send_email', { body: 'your receipt' }, 's'));
    assert.equal(benign.riskScore, 5, 'a different email must not inherit the dangerous score');
    assert.equal(benign.decision, 'allow');
  });
});
