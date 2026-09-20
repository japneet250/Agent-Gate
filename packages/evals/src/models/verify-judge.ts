/**
 * Proves the OpenAI and Gemini judge wiring is correct without spending a
 * single API call.
 *
 * Stands up a local server that impersonates both providers, runs the same
 * scenario through each judge, and asserts that the request each SDK actually
 * sent carries the identical prompt and a structured-output schema -- which is
 * the whole basis for calling the comparison fair.
 *
 *   npm run verify:judge -w @agentgate/evals
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AgentAction, SessionContext } from '@agentgate/shared-types';
import { createJudge } from './judge.js';
import { JudgeInvalidOutput, JudgeUnavailable } from './errors.js';
import { JUDGE_SYSTEM_PROMPT, buildJudgeInput } from './prompt.js';
import { comparisonLabel, hasTierMismatch } from '../compare.js';
import { tierOf, MODEL_IDS } from './registry.js';
import type { SuiteResult } from '../score.js';

type Seen = { provider: string; url: string; body: Record<string, unknown> };

const ACTION: AgentAction = {
  id: 'act_1',
  agentId: 'coding-agent',
  toolName: 'query_database',
  toolArgs: { sql: 'DROP TABLE users;' },
  timestamp: Date.now(),
  sessionId: 'sess_1',
};
const CONTEXT: SessionContext = {
  sessionId: 'sess_1',
  recentActions: [],
  cumulative: { spend: 0, dataAccessCount: 0 },
};

/** What both mock providers "decide", so the parsing path is exercised identically. */
const CANNED = {
  riskScore: 95,
  decision: 'block',
  reasoning: 'Dropping a production table is irreversible.',
  violatedPolicy: 'destructive-sql',
};

/** Drives what the mock providers do, so failure paths can be exercised. */
type Mode = 'ok' | 'malformed' | 'rate-limit-then-ok' | 'always-rate-limited';
let mode: Mode = 'ok';
let rateLimitHits = 0;

async function main() {
  const seen: Seen[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        /* ignore */
      }

      const isProviderCall =
        url.includes('/chat/completions') || url.includes('generateContent');

      if (isProviderCall && mode !== 'ok') {
        if (mode === 'malformed') {
          const provider = url.includes('generateContent') ? 'gemini' : 'openai';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            provider === 'openai'
              ? JSON.stringify({
                  choices: [{ message: { role: 'assistant', content: 'not json at all' } }],
                })
              : JSON.stringify({
                  candidates: [{ content: { parts: [{ text: 'not json at all' }] } }],
                }),
          );
          return;
        }

        const shouldFail = mode === 'always-rate-limited' || rateLimitHits < 2;
        if (shouldFail) {
          rateLimitHits++;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
          return;
        }
      }

      if (url.includes('/chat/completions')) {
        seen.push({ provider: 'openai', url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-local',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(CANNED) },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }

      if (url.includes('generateContent')) {
        seen.push({ provider: 'gemini', url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: JSON.stringify(CANNED) }] } },
            ],
          }),
        );
        return;
      }

      res.writeHead(404).end('{}');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  process.env.OPENAI_BASE_URL = `${base}/v1`;
  process.env.OPENAI_API_KEY = 'sk-local';
  process.env.GEMINI_BASE_URL = base;
  process.env.GEMINI_API_KEY = 'local';

  const results: Record<string, unknown> = {};
  for (const provider of ['openai', 'gemini'] as const) {
    const judge = createJudge({ provider, model: 'mock-model' });
    results[provider] = await judge(ACTION, CONTEXT);
  }

  // --- hardening: schema non-conformance must bucket as invalid ---
  const fastRetry = { attempts: 3, baseDelayMs: 10, maxDelayMs: 40 };
  const invalidBuckets: Record<string, boolean> = {};
  mode = 'malformed';
  for (const provider of ['openai', 'gemini'] as const) {
    const judge = createJudge({ provider, model: 'mock-model', retry: fastRetry });
    try {
      await judge(ACTION, CONTEXT);
      invalidBuckets[provider] = false;
    } catch (err) {
      invalidBuckets[provider] = err instanceof JudgeInvalidOutput;
    }
  }

  // --- hardening: 429 then success must recover ---
  const retryRecovered: Record<string, boolean> = {};
  for (const provider of ['openai', 'gemini'] as const) {
    mode = 'rate-limit-then-ok';
    rateLimitHits = 0;
    let attempts = 0;
    const judge = createJudge({
      provider,
      model: 'mock-model',
      retry: fastRetry,
      onRetry: () => {
        attempts++;
      },
    });
    try {
      const r = (await judge(ACTION, CONTEXT)) as { decision?: string };
      retryRecovered[provider] = r.decision === 'block' && attempts > 0;
    } catch {
      retryRecovered[provider] = false;
    }
  }

  // --- hardening: exhausted retries must bucket as skipped, not wrong ---
  const skippedBuckets: Record<string, boolean> = {};
  for (const provider of ['openai', 'gemini'] as const) {
    mode = 'always-rate-limited';
    rateLimitHits = 0;
    const judge = createJudge({ provider, model: 'mock-model', retry: fastRetry });
    try {
      await judge(ACTION, CONTEXT);
      skippedBuckets[provider] = false;
    } catch (err) {
      skippedBuckets[provider] = err instanceof JudgeUnavailable;
    }
  }

  mode = 'ok';
  server.close();

  // --- hardening: the comparison label must use exact ids, never a family ---
  const fakeSuite = (modelId: string): SuiteResult => ({
    label: modelId,
    modelId,
    rows: [],
    latency: { meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    counts: { scored: 0, invalid: 0, skipped: 0, errored: 0 },
    retries: 0,
  });
  // Read the real defaults rather than hardcoding: a retired model id should
  // show up here as a stale default, not be baked into the test that guards it.
  const defaultPair = [fakeSuite(MODEL_IDS.openai), fakeSuite(MODEL_IDS.gemini)];
  const mixedPair = [fakeSuite('gpt-4o'), fakeSuite(MODEL_IDS.gemini)];
  const label = comparisonLabel(defaultPair);

  const expectedInput = buildJudgeInput(ACTION, CONTEXT);
  const openai = seen.find((s) => s.provider === 'openai');
  const gemini = seen.find((s) => s.provider === 'gemini');

  // What each SDK actually put on the wire.
  const oaMessages = (openai?.body.messages ?? []) as Array<{ role: string; content: string }>;
  const oaSystem = oaMessages.find((m) => m.role === 'system')?.content;
  const oaUser = oaMessages.find((m) => m.role === 'user')?.content;
  const oaSchema = (openai?.body.response_format as { type?: string } | undefined)?.type;

  const gmSystem = (
    gemini?.body.systemInstruction as { parts?: Array<{ text?: string }> } | undefined
  )?.parts?.[0]?.text;
  const gmUser = (
    (gemini?.body.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]
  )?.parts?.[0]?.text;
  const gmConfig = gemini?.body as { generationConfig?: Record<string, unknown> };
  const gmSchema =
    gmConfig?.generationConfig?.responseSchema ?? (gemini?.body as Record<string, unknown>).responseSchema;
  const gmMime =
    gmConfig?.generationConfig?.responseMimeType ??
    (gemini?.body as Record<string, unknown>).responseMimeType;

  const checks: Record<string, boolean> = {
    'openai request sent': Boolean(openai),
    'gemini request sent': Boolean(gemini),
    'openai system prompt matches': oaSystem === JUDGE_SYSTEM_PROMPT,
    'gemini system prompt matches': gmSystem === JUDGE_SYSTEM_PROMPT,
    'prompts identical across providers': oaSystem === gmSystem,
    'openai user input matches': oaUser === expectedInput,
    'gemini user input matches': gmUser === expectedInput,
    'inputs identical across providers': oaUser === gmUser,
    'openai asked for json_schema': oaSchema === 'json_schema',
    'gemini asked for json responseSchema':
      gmMime === 'application/json' && gmSchema !== undefined,
    'openai result banded to block':
      (results.openai as { decision?: string }).decision === 'block',
    'gemini result banded to block':
      (results.gemini as { decision?: string }).decision === 'block',

    // hardening
    'openai malformed output -> invalid bucket': invalidBuckets.openai === true,
    'gemini malformed output -> invalid bucket': invalidBuckets.gemini === true,
    'openai recovers from 429 via backoff': retryRecovered.openai === true,
    'gemini recovers from 429 via backoff': retryRecovered.gemini === true,
    'openai exhausted retries -> skipped bucket': skippedBuckets.openai === true,
    'gemini exhausted retries -> skipped bucket': skippedBuckets.gemini === true,
    'label uses exact model ids': label === `${MODEL_IDS.openai} vs ${MODEL_IDS.gemini}`,
    'label is not a provider family name': !/^GPT-4o vs Gemini$/i.test(label),
    'same-tier pair flagged as comparable': hasTierMismatch(defaultPair) === false,
    'cross-tier pair flagged as mismatch': hasTierMismatch(mixedPair) === true,
    'gpt-4o-mini classed small': tierOf('gpt-4o-mini') === 'small',
    'gpt-4o classed large': tierOf('gpt-4o') === 'large',
  };

  console.log('\n--- judge wiring ---');
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  }
  console.log(`\n  openai -> ${JSON.stringify(results.openai)}`);
  console.log(`  gemini -> ${JSON.stringify(results.gemini)}`);
  console.log(`  comparison label for the default ids -> "${label}"`);

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — mock providers, no API spend`);
  if (failed.length > 0) process.exit(1);
}

main();
