import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentAction } from '@agentgate/shared';
import { DEFAULT_CONFIG, configFromEnv, createRuleEngine, type RulesConfig } from './rules.js';
import { createEvaluator } from './evaluate.js';

let n = 0;
const action = (toolName: string, toolArgs: Record<string, unknown> = {}, extra: Partial<AgentAction> = {}): AgentAction => ({
  id: `a${n++}`,
  agentId: 'agent-1',
  toolName,
  toolArgs,
  timestamp: new Date(),
  sessionId: 's1',
  ...extra,
});

const evaluate = (a: AgentAction, config: RulesConfig = DEFAULT_CONFIG) => createEvaluator(config)(a);

describe('PII detector', () => {
  it('blocks an SSN in any field', async () => {
    const r = await evaluate(action('send_email', { body: 'my SSN is 123-45-6789' }));
    assert.equal(r.decision, 'block');
    assert.match(r.reasoning, /SSN in "body"/);
    assert.equal(r.violatedPolicy, 'pii_detector');
  });

  it('never echoes the sensitive value in the reason', async () => {
    const r = await evaluate(action('send_email', { body: 'SSN 123-45-6789, card 4111 1111 1111 1111' }));
    assert.ok(!r.reasoning.includes('123-45-6789'));
    assert.ok(!r.reasoning.includes('4111'));
  });

  it('ignores impossible SSNs', async () => {
    for (const ssn of ['000-12-3456', '666-12-3456', '900-12-3456', '123-00-6789', '123-45-0000']) {
      assert.equal((await evaluate(action('note', { text: ssn }))).decision, 'allow', ssn);
    }
  });

  it('blocks credit card numbers that pass the Luhn check, with or without separators', async () => {
    for (const card of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '378282246310005']) {
      assert.equal((await evaluate(action('note', { text: `card: ${card}` }))).decision, 'block', card);
    }
  });

  it('ignores 16-digit numbers that fail the Luhn check', async () => {
    assert.equal((await evaluate(action('note', { text: '4111111111111112' }))).decision, 'allow');
  });

  it('catches numeric card values and nested/array arguments', async () => {
    assert.equal((await evaluate(action('note', { card: 4111111111111111 }))).decision, 'block');
    const r = await evaluate(action('note', { items: [{ note: 'ssn 123-45-6789' }] }));
    assert.equal(r.decision, 'block');
    assert.match(r.reasoning, /items\[0\]\.note/);
  });

  it('escalates an email or phone number in free text', async () => {
    assert.equal((await evaluate(action('send_email', { body: 'reach me at jo@example.com' }))).decision, 'escalate');
    assert.equal((await evaluate(action('send_email', { body: 'call (416) 555-0199' }))).decision, 'escalate');
    assert.equal((await evaluate(action('send_email', { body: 'call 416-555-0199' }))).decision, 'escalate');
  });

  it('allows emails and phones in address-style fields', async () => {
    assert.equal((await evaluate(action('send_email', { to: 'jo@example.com', subject: 'Hi' }))).decision, 'allow');
    assert.equal((await evaluate(action('lookup_customer', { email: 'jo@example.com', phone: '416-555-0199' }))).decision, 'allow');
    assert.equal((await evaluate(action('send_email', { to: ['a@b.com', 'c@d.org'] }))).decision, 'allow');
  });

  it('does not flag ordinary ids, dates and amounts', async () => {
    const r = await evaluate(action('lookup_order', { order_id: '1234567890', date: '2026-09-19', qty: 3 }));
    assert.equal(r.decision, 'allow');
  });
});

describe('destructive command blocker', () => {
  const blockedCommands: [string, Record<string, unknown>][] = [
    ['run_command', { command: 'rm -rf /' }],
    ['run_command', { command: 'sudo rm -fr /var/data' }],
    ['run_command', { command: 'rm -r ./build' }],
    ['run_command', { command: 'rm --recursive dir' }],
    ['run_command', { command: 'rm -rf --no-preserve-root /' }],
    ['query_database', { sql: 'DROP TABLE users' }],
    ['query_database', { sql: 'drop database prod' }],
    ['query_database', { sql: 'TRUNCATE TABLE orders' }],
    ['query_database', { sql: 'DELETE FROM users' }],
    ['query_database', { sql: 'SELECT 1; DELETE FROM users;' }],
    ['run_command', { command: 'mkfs.ext4 /dev/sda1' }],
    ['run_command', { command: 'format C:' }],
    ['run_command', { command: 'dd if=/dev/zero of=/dev/sda' }],
  ];
  for (const [tool, args] of blockedCommands) {
    it(`blocks ${tool} ${JSON.stringify(args)}`, async () => {
      const r = await evaluate(action(tool, args));
      assert.equal(r.decision, 'block');
      assert.equal(r.violatedPolicy, 'destructive_command');
    });
  }

  it('escalates a DELETE that has a WHERE clause', async () => {
    assert.equal((await evaluate(action('query_database', { sql: 'DELETE FROM users WHERE id = 7' }))).decision, 'escalate');
  });

  it('allows ordinary commands and queries', async () => {
    const safe: [string, Record<string, unknown>][] = [
      ['run_command', { command: 'ls -la && git status' }],
      ['run_command', { command: 'rm old.txt' }],
      ['run_command', { command: 'rm -f old.txt' }],
      ['query_database', { sql: 'SELECT * FROM users WHERE id = 1' }],
      ['query_database', { sql: "SELECT to_char(d, 'YYYY') AS format FROM t" }],
    ];
    for (const [tool, args] of safe) assert.equal((await evaluate(action(tool, args))).decision, 'allow', JSON.stringify(args));
  });

  it('only inspects shell/SQL tools', async () => {
    assert.equal((await evaluate(action('write_note', { text: 'notes about DROP TABLE and rm -rf' }))).decision, 'allow');
  });
});

describe('spending limit', () => {
  it('blocks a payment above the limit', async () => {
    const r = await evaluate(action('issue_refund', { customer: 'c1', amount: 900 }));
    assert.equal(r.decision, 'block');
    assert.equal(r.violatedPolicy, 'spending_limit');
    assert.match(r.reasoning, /limit is 500/);
  });

  it('allows a payment at or below the limit', async () => {
    assert.equal((await evaluate(action('approve_payment', { amount: 400 }))).decision, 'allow');
    assert.equal((await evaluate(action('approve_payment', { amount: 500 }))).decision, 'allow');
  });

  it('parses string amounts and nested fields', async () => {
    assert.equal((await evaluate(action('approve_payment', { amount: '$1,200.50' }))).decision, 'block');
    assert.equal((await evaluate(action('create_purchase_order', { order: { total: 12000 } }))).decision, 'block');
  });

  it('ignores amount fields on non-payment tools', async () => {
    assert.equal((await evaluate(action('check_budget', { amount: 99999 }))).decision, 'allow');
  });

  it('respects a custom limit', async () => {
    const config = { ...DEFAULT_CONFIG, spendLimit: 50 };
    assert.equal((await evaluate(action('approve_payment', { amount: 60 }), config)).decision, 'block');
  });
});

describe('rate limiter', () => {
  const at = (ms: number, agentId = 'agent-1') => action('lookup_order', { id: '1' }, { agentId, timestamp: new Date(ms) });

  it('throttles the 21st call inside a minute', async () => {
    const evaluator = createEvaluator();
    for (let i = 0; i < 20; i++) assert.equal((await evaluator(at(1000 + i))).decision, 'allow', `call ${i + 1}`);
    const r = await evaluator(at(1030));
    assert.equal(r.decision, 'block');
    assert.equal(r.violatedPolicy, 'rate_limit');
  });

  it('counts each agent separately', async () => {
    const evaluator = createEvaluator();
    for (let i = 0; i < 21; i++) await evaluator(at(1000 + i, 'noisy'));
    assert.equal((await evaluator(at(1100, 'quiet'))).decision, 'allow');
  });

  it('recovers once the window passes', async () => {
    const evaluator = createEvaluator();
    for (let i = 0; i < 25; i++) await evaluator(at(1000 + i));
    assert.equal((await evaluator(at(1000 + 61_000))).decision, 'allow');
  });

  it('still counts calls that other rules already blocked', async () => {
    const engine = createRuleEngine();
    for (let i = 0; i < 21; i++) engine.run(action('run_command', { command: 'rm -rf /' }));
    assert.ok(engine.run(action('lookup_order', { id: '1' })).rules.includes('rate_limit'));
  });
});

describe('blocked tool list', () => {
  const config: RulesConfig = { ...DEFAULT_CONFIG, blockedTools: ['delete_account', 'admin_*'] };

  it('blocks exact names and wildcards, case-insensitively', async () => {
    for (const tool of ['delete_account', 'DELETE_ACCOUNT', 'admin_reset', 'admin_']) {
      const r = await evaluate(action(tool), config);
      assert.equal(r.decision, 'block', tool);
      assert.equal(r.violatedPolicy, 'blocked_tool');
    }
  });

  it('does not block similar names', async () => {
    for (const tool of ['delete_account_preview', 'my_admin_tool', 'lookup_order']) {
      assert.equal((await evaluate(action(tool), config)).decision, 'allow', tool);
    }
  });

  it('is configurable from the environment', () => {
    const c = configFromEnv({ AGENTGATE_BLOCKED_TOOLS: ' a , b* ', AGENTGATE_SPEND_LIMIT: '100', AGENTGATE_RATE_LIMIT: 'x' });
    assert.deepEqual(c.blockedTools, ['a', 'b*']);
    assert.equal(c.spendLimit, 100);
    assert.equal(c.rateLimit.maxCalls, 20); // invalid value falls back to the default
  });
});

describe('evaluator', () => {
  it('reports every rule that matched and the highest score', async () => {
    const r = await evaluate(action('run_command', { command: 'DROP TABLE users', note: 'ssn 123-45-6789' }));
    assert.equal(r.decision, 'block');
    assert.equal(r.violatedPolicy, 'pii_detector,destructive_command');
    assert.equal(r.riskScore, 95);
  });

  it('hands calls no rule matched to the judge', async () => {
    let asked = 0;
    const evaluator = createEvaluator(DEFAULT_CONFIG, async () => {
      asked++;
      return { riskScore: 55, decision: 'escalate', reasoning: 'judge says hmm', latencyMs: 1 };
    });
    assert.equal((await evaluator(action('lookup_order', { id: '1' }))).decision, 'escalate');
    assert.equal(asked, 1);
    await evaluator(action('send_email', { body: 'SSN 123-45-6789' }));
    assert.equal(asked, 1, 'a rule match must not reach the judge');
  });

  it('is fast: rule verdicts in under 10ms', async () => {
    const evaluator = createEvaluator();
    const big = { body: 'lorem ipsum '.repeat(500) + ' 123-45-6789', rows: Array.from({ length: 50 }, (_, i) => ({ i, note: 'x'.repeat(50) })) };
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await evaluator(action('send_email', big, { agentId: `agent-${i}` }));
      times.push(performance.now() - t);
    }
    const worst = Math.max(...times);
    assert.ok(worst < 10, `slowest verdict took ${worst.toFixed(2)}ms`);
  });
});
