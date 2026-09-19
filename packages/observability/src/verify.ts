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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

type Captured = { sentry: unknown[]; langfuse: unknown[] };

async function main() {
  let captured: Captured = { sentry: [], langfuse: [] };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';

      if (url.includes('/envelope')) {
        // Sentry envelopes are newline-delimited JSON.
        for (const line of body.split('\n')) {
          if (!line.trim()) continue;
          try {
            captured.sentry.push(JSON.parse(line));
          } catch {
            /* envelope headers we don't care about */
          }
        }
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
    const trails = captured.sentry.map((item) => {
      const ev = item as { breadcrumbs?: Array<{ category?: string; message?: string }> };
      return (ev.breadcrumbs ?? []).filter((b) => b.category === 'agentgate.evaluate');
    });
    const breadcrumbs = trails.sort((a, b) => b.length - a.length)[0] ?? [];
    const messages = captured.sentry.filter(
      (item) => (item as { message?: unknown }).message !== undefined,
    );
    // span-create carries the name; span-update is the matching end event.
    const spans = captured.langfuse.filter(
      (e) => ((e as { type?: string }).type ?? '') === 'span-create',
    );
    const traces = captured.langfuse.filter((e) =>
      ((e as { type?: string }).type ?? '').startsWith('trace'),
    );
    const spanNames = [
      ...new Set(
        spans.map((s) => ((s as { body?: { name?: string } }).body?.name ?? '?')),
      ),
    ].sort();

    console.log(`\n--- ${label}: what the collector received ---`);
    console.log(`  sentry  : ${captured.sentry.length} payload(s)`);
    console.log(
      `            ${messages.length} event(s), longest agentgate.evaluate trail = ${breadcrumbs.length}`,
    );
    for (const b of breadcrumbs.slice(0, 6)) console.log(`              · ${b.message}`);
    if (breadcrumbs.length > 6)
      console.log(`              · ... ${breadcrumbs.length - 6} more`);
    console.log(`  langfuse: ${captured.langfuse.length} ingest event(s)`);
    console.log(`            ${traces.length} trace(s), ${spans.length} span(s): ${spanNames.join(', ') || 'none'}`);

    const ok = breadcrumbs.length > 0 && spans.length > 0 && code === 0;
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
