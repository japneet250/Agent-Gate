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
import { JUDGE_SYSTEM_PROMPT, buildJudgeInput } from './prompt.js';

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

  server.close();

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
  };

  console.log('\n--- judge wiring ---');
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  }
  console.log(`\n  openai -> ${JSON.stringify(results.openai)}`);
  console.log(`  gemini -> ${JSON.stringify(results.gemini)}`);

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — mock providers, no API spend`);
  if (failed.length > 0) process.exit(1);
}

main();
