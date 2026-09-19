/**
 * Proves Sentry and LangFuse actually emit.
 *
 * Stands up a local HTTP collector that speaks enough of both ingest protocols
 * to accept an envelope, points a real demo-agent run at it, and prints what
 * arrived. No live keys needed -- so this is also a regression test that the
 * wiring still works after a refactor.
 *
 *   npm run verify -w @agentgate/observability
 */
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

type EnvelopeItem = { header: Record<string, unknown>; payload: Record<string, unknown> };
type Captured = { sentry: EnvelopeItem[]; langfuse: unknown[] };

/**
 * A Sentry envelope is newline-delimited JSON: one envelope header, then
 * alternating item-header / item-payload pairs. Parsing it properly (rather
 * than grepping every line) is what lets us tell an event from a transaction
 * from a log batch.
 */
function parseEnvelope(body: string): EnvelopeItem[] {
  const lines = body.split('\n').filter((l) => l.trim());
  const items: EnvelopeItem[] = [];
  for (let i = 1; i < lines.length; i += 2) {
    try {
      const header = JSON.parse(lines[i]!) as Record<string, unknown>;
      const payload = JSON.parse(lines[i + 1] ?? '{}') as Record<string, unknown>;
      items.push({ header, payload });
    } catch {
      /* a malformed tail is not worth failing the check over */
    }
  }
  return items;
}

async function main() {
  let captured: Captured = { sentry: [], langfuse: [] };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      // Sentry gzips envelopes once they pass a size threshold -- a transaction
      // carrying a few dozen spans does. Reading it as utf8 silently yields
      // garbage, so decompress before parsing.
      const body = (
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      ).toString('utf8');
      const url = req.url ?? '';

      if (url.includes('/envelope')) {
        captured.sentry.push(...parseEnvelope(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"local"}');
        return;
      }

      if (url.includes('/api/public/ingestion')) {
        try {
          const parsed = JSON.parse(body) as { batch?: unknown[] };
          captured.langfuse.push(...(parsed.batch ?? []));
        } catch {
          /* ignore */
        }
        res.writeHead(207, { 'content-type': 'application/json' });
        res.end('{"successes":[],"errors":[]}');
        return;
      }

      res.writeHead(200).end('{}');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  console.log(`local collector listening on ${base}\n`);

  const env = {
    ...process.env,
    SENTRY_DSN: `http://publickey@127.0.0.1:${port}/1`,
    LANGFUSE_PUBLIC_KEY: 'pk-lf-local',
    LANGFUSE_SECRET_KEY: 'sk-lf-local',
    LANGFUSE_BASE_URL: base,
  };

  async function run(label: string, args: string[]): Promise<boolean> {
    captured = { sentry: [], langfuse: [] };
    console.log(`\n=== ${label} ===`);
    const child = spawn('npm', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
    });
    const [code] = (await once(child, 'close')) as [number];
    // Both SDKs flush on exit, but the last request can land a beat later.
    await new Promise((r) => setTimeout(r, 500));
    return report(label, code);
  }

  function report(label: string, code: number): boolean {
    // Sentry attaches the whole trail to every event, so take the longest one
    // rather than summing across events.
    const itemsOfType = (t: string) =>
      captured.sentry.filter((i) => i.header.type === t).map((i) => i.payload);

    const events = itemsOfType('event');
    const transactions = itemsOfType('transaction');
    const logBatches = itemsOfType('log');

    const trails = events.map((ev) => {
      const e = ev as { breadcrumbs?: Array<{ category?: string; message?: string }> };
      return (e.breadcrumbs ?? []).filter((b) => b.category === 'agentgate.evaluate');
    });
    const breadcrumbs = trails.sort((a, b) => b.length - a.length)[0] ?? [];

    // Each transaction carries its child spans; count the evaluation ones.
    const evalSpans = transactions.flatMap((t) => {
      const spans = (t as { spans?: Array<{ op?: string }> }).spans ?? [];
      return spans.filter((sp) => sp.op === 'agentgate.evaluate');
    });
    const spanAttrs = evalSpans
      .map((sp) => (sp as { data?: Record<string, unknown> }).data ?? {})
      .filter((d) => d['agentgate.decision'] !== undefined);

    const logs = logBatches.flatMap(
      (b) => (b as { items?: Array<{ level?: string; body?: string }> }).items ?? [],
    );

    const langfuseSpans = captured.langfuse.filter(
      (e) => ((e as { type?: string }).type ?? '') === 'span-create',
    );
    const scores = captured.langfuse.filter((e) =>
      ((e as { type?: string }).type ?? '').startsWith('score'),
    );
    const traces = captured.langfuse.filter((e) =>
      ((e as { type?: string }).type ?? '').startsWith('trace'),
    );
    const spanNames = [
      ...new Set(
        langfuseSpans.map((sp) => ((sp as { body?: { name?: string } }).body?.name ?? '?')),
      ),
    ].sort();

    console.log(`\n--- ${label}: what the collector received ---`);
    console.log(`  sentry`);
    console.log(
      `    events      : ${events.length}, longest agentgate.evaluate breadcrumb trail = ${breadcrumbs.length}`,
    );
    for (const b of breadcrumbs.slice(0, 4)) console.log(`                  · ${b.message}`);
    if (breadcrumbs.length > 4)
      console.log(`                  · ... ${breadcrumbs.length - 4} more`);
    console.log(
      `    transactions: ${transactions.length}, with ${evalSpans.length} agentgate.evaluate span(s)`,
    );
    if (spanAttrs[0]) {
      const a = spanAttrs[0];
      console.log(
        `                  · sample attrs: decision=${a['agentgate.decision']} risk=${a['agentgate.risk_score']} tool=${a['agentgate.tool_name']} path=${a['agentgate.path']} latency=${a['agentgate.latency_ms']}ms`,
      );
    }
    console.log(`    logs        : ${logs.length}`);
    for (const l of logs.slice(0, 3)) console.log(`                  · [${l.level}] ${l.body}`);
    if (logs.length > 3) console.log(`                  · ... ${logs.length - 3} more`);
    console.log(`  langfuse`);
    console.log(
      `    traces ${traces.length}, spans ${langfuseSpans.length} (${spanNames.join(', ') || 'none'}), scores ${scores.length}`,
    );

    // Every product we claim must actually have produced something.
    const checks = {
      breadcrumbs: breadcrumbs.length > 0,
      transactions: transactions.length > 0,
      evaluationSpans: evalSpans.length > 0,
      spanAttributes: spanAttrs.length > 0,
      logs: logs.length > 0,
      langfuseSpans: langfuseSpans.length > 0,
      exitedClean: code === 0,
    };
    const failed = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const ok = failed.length === 0;
    if (!ok) console.log(`    missing: ${failed.join(', ')}`);
    console.log(`\n${ok ? 'PASS' : 'FAIL'} — ${label} exited ${code}`);
    return ok;
  }

  const results = [
    await run('demo-agents', [
      'run', 'agent', '-w', '@agentgate/demo-agents', '--',
      '--agent=coding', '--mode=dangerous',
    ]),
    await run('evals', [
      'run', 'eval', '-w', '@agentgate/evals', '--', '--category=dangerous',
    ]),
  ];

  server.close();
  if (results.some((r) => !r)) process.exit(1);
  console.log('\nBoth processes emit to Sentry and LangFuse.');
}

main();
