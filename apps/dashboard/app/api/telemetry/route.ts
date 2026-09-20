/**
 * Live pipeline telemetry, read back out of LangFuse.
 *
 * The engine emits one trace per evaluation with a span per pipeline node. That
 * telemetry was only ever visible in LangFuse's own UI, which means the whole
 * observability layer was invisible to anyone looking at the control plane —
 * the thing that is supposed to show how the system behaves.
 *
 * This route pulls it back. Server-side, because the LangFuse secret key must
 * never reach the browser.
 *
 * What is deliberately NOT returned: token counts and cost. The engine's
 * generations arrive without usage or model pricing attached (`modelId` and
 * `totalPrice` are null on every observation), so any figure here would be
 * invented. A missing panel is honest; a fabricated dollar amount is not.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const HOST = process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL ?? 'https://us.cloud.langfuse.com';
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? '';
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? '';

/** The pipeline, in execution order. Anything else LangFuse reports is appended
 *  after these, so a new node shows up rather than being silently dropped. */
const NODE_ORDER = [
  'classifier.run',
  'policy_retriever.search',
  'risk_judge.evaluate',
  'decision_gate.decide',
  'pattern_detector.check',
];
const ROOT_SPAN = 'agentgate.evaluate';

type Observation = {
  id: string;
  traceId: string;
  type: 'SPAN' | 'GENERATION' | 'EVENT' | string;
  name: string;
  latency: number | null;
  startTime: string;
  level?: string;
};

export type NodeStat = {
  name: string;
  type: string;
  calls: number;
  meanMs: number;
  p95Ms: number;
  shareOfTotal: number;
};

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

export async function GET(request: Request) {
  if (!PUBLIC_KEY || !SECRET_KEY) {
    return NextResponse.json(
      { error: 'LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set for the dashboard process' },
      { status: 503 },
    );
  }

  const hours = Number(new URL(request.url).searchParams.get('hours') ?? 24);
  const from = new Date(Date.now() - hours * 3_600_000).toISOString();
  // A little into the future: clock skew between this host and LangFuse should
  // not silently truncate the most recent evaluation, which is the one someone
  // just triggered on stage.
  const to = new Date(Date.now() + 3_600_000).toISOString();

  const auth = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');
  const url =
    `${HOST}/api/public/v2/observations` +
    `?fromStartTime=${encodeURIComponent(from)}&toStartTime=${encodeURIComponent(to)}&limit=100`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `LangFuse returned ${res.status}`, detail: (await res.text()).slice(0, 300) },
        { status: 502 },
      );
    }

    const body = (await res.json()) as { data?: Observation[] };
    const obs = body.data ?? [];

    const buckets = new Map<string, { type: string; lat: number[] }>();
    const traces = new Set<string>();
    let alerts = 0;

    for (const o of obs) {
      traces.add(o.traceId);
      if (o.name === 'pattern.alert') alerts++;
      // GENERATION spans duplicate their parent SPAN's window (classifier.llm
      // inside classifier.run), so counting both would double the pipeline.
      if (o.type !== 'SPAN') continue;
      const b = buckets.get(o.name) ?? { type: o.type, lat: [] };
      if (typeof o.latency === 'number') b.lat.push(o.latency * 1000);
      buckets.set(o.name, b);
    }

    const rootMean = (() => {
      const r = buckets.get(ROOT_SPAN);
      if (!r || !r.lat.length) return 0;
      return r.lat.reduce((a, b) => a + b, 0) / r.lat.length;
    })();

    const stat = (name: string): NodeStat | null => {
      const b = buckets.get(name);
      if (!b || !b.lat.length) return null;
      const sorted = [...b.lat].sort((a, b2) => a - b2);
      const mean = b.lat.reduce((a, b2) => a + b2, 0) / b.lat.length;
      return {
        name,
        type: b.type,
        calls: b.lat.length,
        meanMs: Math.round(mean),
        p95Ms: Math.round(percentile(sorted, 0.95)),
        shareOfTotal: rootMean > 0 ? mean / rootMean : 0,
      };
    };

    const known = NODE_ORDER.map(stat).filter((n): n is NodeStat => n !== null);
    const extra = [...buckets.keys()]
      .filter((n) => n !== ROOT_SPAN && !NODE_ORDER.includes(n))
      .map(stat)
      .filter((n): n is NodeStat => n !== null);

    return NextResponse.json({
      source: HOST,
      windowHours: hours,
      // Sampled, not total: the API pages at 100 observations and this reads the
      // most recent page. Labelled so nobody reads it as a lifetime count.
      observations: obs.length,
      traces: traces.size,
      patternAlerts: alerts,
      totalMeanMs: Math.round(rootMean),
      nodes: [...known, ...extra],
      note: 'Per-node latency measured by the engine and reported by LangFuse. Token cost is not instrumented, so none is shown.',
    });
  } catch (err) {
    return NextResponse.json(
      { error: `cannot reach LangFuse at ${HOST}: ${(err as Error).message}` },
      { status: 503 },
    );
  }
}
