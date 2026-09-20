'use client';

import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PipelineDiagram } from '@/components/demo/flow';

/**
 * Live pipeline telemetry, read back out of LangFuse.
 *
 * The engine traces every evaluation with a span per node. Until now that only
 * existed in LangFuse's own UI, so the observability work was invisible on the
 * control plane — which is the screen that is meant to show how the system
 * behaves. This panel is the eval and LLMOps layer made visible.
 *
 * Every number here was measured by the engine and reported by LangFuse. There
 * is no token cost shown because the generations arrive without usage or model
 * pricing attached; a fabricated dollar figure would be worse than an absent one.
 */
type NodeStat = {
  name: string;
  calls: number;
  meanMs: number;
  p95Ms: number;
  shareOfTotal: number;
};

type Telemetry = {
  source: string;
  windowHours: number;
  observations: number;
  traces: number;
  patternAlerts: number;
  totalMeanMs: number;
  nodes: NodeStat[];
  note: string;
};

/** Human labels for the span names the engine emits. */
const LABELS: Record<string, string> = {
  'classifier.run': 'Classifier',
  'policy_retriever.search': 'Policy retrieval (RAG)',
  'risk_judge.evaluate': 'Risk judge',
  'decision_gate.decide': 'Decision gate',
  'pattern_detector.check': 'Pattern detector',
};

const MODEL: Record<string, string> = {
  'classifier.run': 'gpt-4o-mini',
  'policy_retriever.search': 'text-embedding-3-small + BM25',
  'risk_judge.evaluate': 'gpt-4o · function calling',
  'decision_gate.decide': 'no model',
  'pattern_detector.check': 'no model',
};

export function PipelineTelemetry() {
  const [data, setData] = useState<Telemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/telemetry', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `telemetry returned ${res.status}`);
        setData(null);
      } else {
        setData(body);
        setError(null);
      }
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  // Poll slowly. This is an aggregate over hours; a fast poll would hammer
  // LangFuse to redraw a bar that barely moves.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return (
      <section className="surface no-blur rounded-card border-l-2 border-l-escalate p-5">
        <h2 className="flex items-center gap-2 text-body font-semibold text-escalate">
          <AlertTriangle className="h-4 w-4" />
          Pipeline telemetry unavailable
        </h2>
        <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-muted">{error}</p>
        <p className="mt-2 text-meta text-dim">
          The engine still traces every evaluation; this panel just cannot read it back.
        </p>
      </section>
    );
  }

  return (
    <section className="surface no-blur rounded-card p-5">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-body font-semibold text-paper">
            <Activity className="h-4 w-4 text-accent" />
            Pipeline telemetry
            <span className="rounded-pill bg-accent/10 px-2 py-0.5 text-meta font-normal text-accent">
              live · LangFuse
            </span>
          </h2>
          <p className="mt-1 text-meta text-dim">
            Every evaluation is traced end to end, one span per node. Measured by the engine, read back
            through the LangFuse API.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex shrink-0 items-center gap-1.5 rounded-field border border-line px-2.5 py-1 text-meta text-muted transition hover:text-paper active:scale-[.96]"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </header>

      {!data && loading && <p className="text-body text-muted">Reading traces…</p>}

      {data && (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Traces" value={String(data.traces)} hint={`last ${data.windowHours}h, sampled`} />
            <Stat label="Spans" value={String(data.observations)} hint="most recent page" />
            <Stat label="End to end" value={`${data.totalMeanMs}ms`} hint="mean, full pipeline" />
            <Stat
              label="Pattern alerts"
              value={String(data.patternAlerts)}
              hint="cumulative limits fired"
              tone={data.patternAlerts > 0 ? 'escalate' : 'muted'}
            />
          </dl>

          {/* The shape first, then the measurements. The bars below are the
              same stages, timed. */}
          <PipelineDiagram className="mb-4 h-auto w-full" />

          <div className="space-y-2.5">
            {data.nodes.map((n) => (
              <div key={n.name}>
                <div className="flex items-baseline justify-between gap-3 text-meta">
                  <span className="text-paper">{LABELS[n.name] ?? n.name}</span>
                  <span className="shrink-0 font-mono text-dim">
                    {n.meanMs}ms · p95 {n.p95Ms}ms · {n.calls} calls
                  </span>
                </div>
                {/* Width is the node's share of the mean end-to-end time, so the
                    bar reads as "where the two seconds actually go". */}
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-pill bg-ink-900">
                  <div
                    className="h-full rounded-pill bg-accent transition-all duration-500"
                    style={{ width: `${Math.max(1, Math.min(100, n.shareOfTotal * 100))}%` }}
                  />
                </div>
                <p className="mt-0.5 text-meta text-dim">{MODEL[n.name] ?? ''}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 text-meta leading-relaxed text-dim">
            {data.note} Source: <code className="font-mono text-muted">{data.source}</code>.
          </p>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'muted',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'muted' | 'escalate';
}) {
  return (
    <div>
      <dt className="text-meta uppercase tracking-wider text-dim">{label}</dt>
      <dd className={cn('mt-0.5 font-mono text-title', tone === 'escalate' ? 'text-escalate' : 'text-paper')}>
        {value}
      </dd>
      {hint && <p className="text-meta text-dim">{hint}</p>}
    </div>
  );
}
