/**
 * The eval benchmark, read from disk at request time.
 *
 * It used to be baked into the client bundle by the fixture generator, which
 * meant a fresh `npm run eval` changed nothing on screen until someone
 * rebuilt the dashboard. A measurement that cannot be re-measured without a
 * build step is a screenshot, not a control plane.
 *
 * Now: re-run the harness, refresh the page, see the new number.
 *
 * Provenance travels with it. `report.json` is a local run of any model;
 * `report.baseline.json` is the committed one. Only a `--model=engine` run is
 * AgentGate's own score, and `isProductNumber` says which this is so the UI can
 * keep labelling an eval-engineering artifact as one.
 */
import { NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const REPO = path.resolve(process.cwd(), '../..');
const CANDIDATES = [
  { file: 'packages/evals/report.json', label: 'local run' },
  { file: 'packages/evals/report.baseline.json', label: 'committed baseline' },
];

export async function GET() {
  for (const c of CANDIDATES) {
    const abs = path.join(REPO, c.file);
    try {
      const [raw, info] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
      const r = JSON.parse(raw);
      const m = r.metrics ?? {};
      return NextResponse.json({
        source: c.file,
        sourceLabel: c.label,
        generatedAt: r.generatedAt ?? null,
        fileModifiedAt: info.mtime.toISOString(),
        engine: r.engine ?? r.model ?? 'unknown',
        model: r.model ?? 'unknown',
        // The guard that keeps a stub run from being quoted as the product's
        // score. The UI prints a banner when this is false.
        isProductNumber: Boolean(r.isProductNumber),
        scenarioCount: r.scenarioCount ?? m.total ?? 0,
        counts: r.counts ?? null,
        accuracy: m.accuracy ?? null,
        macroF1: m.macroF1 ?? null,
        weightedF1: m.weightedF1 ?? null,
        perClass: m.perClass ?? null,
        confusion: m.confusion ?? null,
        byCategory: r.byCategory ?? null,
        latency: r.latency ?? null,
      });
    } catch {
      // Try the next candidate. A missing local run is the normal case on a
      // fresh clone, not an error.
    }
  }
  return NextResponse.json(
    {
      error: 'no eval report on disk',
      hint: 'npm run eval -w @agentgate/evals -- --model=engine --update-baseline',
    },
    { status: 404 },
  );
}
