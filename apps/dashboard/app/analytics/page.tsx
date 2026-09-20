'use client';

import { AlertTriangle, FlaskConical, Zap, Brain, Timer } from 'lucide-react';
import { useMetrics, useActionFeed, provenance } from '@/lib/data';
import { PerClassChart, ConfusionMatrix, CategoryChart } from '@/components/analytics/charts';
import { PipelineTelemetry } from '@/components/analytics/telemetry';
import { LiveOperations } from '@/components/analytics/live-ops';
import { cn, formatLatency, pct } from '@/lib/utils';
import { DECISION_FILL } from '@/lib/chart-tokens';

export default function AnalyticsPage() {
  const { metrics, loaded, mode } = useMetrics();
  const { actions } = useActionFeed();

  const rule = actions.filter((a) => a.path === 'rule');
  const judge = actions.filter((a) => a.path === 'judge');
  const avg = (xs: typeof actions) => (xs.length ? xs.reduce((s, a) => s + a.result.latencyMs, 0) / xs.length : 0);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      <header className="mb-5">
        <h1 className="text-title">Analytics</h1>
        <p className="mt-0.5 text-body text-muted">
          Measured behaviour of the evaluation engine against the labelled scenario suite.
        </p>
      </header>

      {/* Live first, benchmark second. The benchmark is a measurement with a
          date on it; these two are the system as it is behaving right now, and
          leading with them is what makes the eval and observability work
          visible to anyone who opens this page. */}
      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <LiveOperations />
        <PipelineTelemetry />
      </div>

      <h2 className="mb-3 text-body font-semibold text-paper">Benchmark — labelled scenario suite</h2>

      {!loaded && <div className="surface no-blur rounded-card p-6 text-body text-muted">Loading…</div>}

      {loaded && !metrics && (
        <div className="surface no-blur rounded-card border-l-2 border-l-escalate p-5">
          <h2 className="flex items-center gap-2 text-body font-semibold text-escalate">
            <AlertTriangle className="h-4 w-4" />
            No benchmark data
          </h2>
          <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-muted">
            {mode === 'live'
              ? 'The benchmark is produced offline by the eval harness; a running system does not report one. Switch to mock mode, or run the harness and rebuild fixtures.'
              : 'packages/evals/report.json was absent when fixtures were generated.'}{' '}
            Rather than show an invented figure, this panel shows nothing.
          </p>
          <code className="mt-3 block rounded-field bg-ink-900 px-3 py-2 font-mono text-meta text-paper">
            npm run eval -w @agentgate/evals -- --model=engine --update-baseline
          </code>
        </div>
      )}

      {metrics && (
        <>
          {/* ---------------------------------------------- headline stat tile */}
          <section className="glass glass-edge mb-5 rounded-panel p-3">
            {/* The panel FRAME is glass; the numbers sit on an opaque inner
                surface. This is the headline figure read from the back of a
                room — it never sits on translucency. */}
            <div className="surface no-blur flex flex-wrap items-end gap-x-10 gap-y-4 rounded-card p-4">
              <div>
                <p className="text-meta uppercase tracking-wider text-dim">Decision accuracy</p>
                <p className="num mt-1 text-[3.5rem] font-semibold leading-none text-paper">
                  {pct(metrics.accuracy, 1)}
                </p>
                <p className="mt-1 text-meta text-muted">
                  {metrics.scenarioCount} labelled scenarios · macro-F1{' '}
                  <span className="num text-paper">{metrics.macroF1.toFixed(3)}</span>
                </p>
              </div>

              <dl className="flex gap-8">
                <Fig label="Block recall" value={pct(metrics.perClass.block.recall, 0)} tone="allow" hint="no threat missed" />
                <Fig
                  label="Escalate recall"
                  value={pct(metrics.perClass.escalate.recall, 0)}
                  tone="block"
                  hint="the known weakness"
                />
                <Fig label="Allow recall" value={pct(metrics.perClass.allow.recall, 0)} tone="muted" />
              </dl>
            </div>

            <p
              className={cn(
                'mt-4 flex items-start gap-2 rounded-field border px-3 py-2 text-meta leading-relaxed',
                metrics.isProductNumber
                  ? 'border-allow/25 bg-allow/[0.06] text-muted'
                  : 'border-block/40 bg-block/[0.08] text-block',
              )}
            >
              <FlaskConical className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
              <span>
                {metrics.isProductNumber ? (
                  <>
                    Measured against <strong className="text-paper">{metrics.engine}</strong>, the real engine. This is
                    AgentGate&apos;s score. Generated {metrics.generatedAt.slice(0, 16).replace('T', ' ')}.
                  </>
                ) : (
                  <>
                    <strong>NOT A PRODUCT NUMBER.</strong> This run scored &quot;{metrics.engine}&quot;, which is an
                    eval-engineering artifact, not the product. Do not quote it.
                  </>
                )}
              </span>
            </p>
          </section>

          {/* ---------------------------------------------- charts */}
          <div className="grid gap-4 xl:grid-cols-2">
            <PerClassChart metrics={metrics} />
            <ConfusionMatrix metrics={metrics} />
            <CategoryChart metrics={metrics} />

            {/* Latency: numbers, not a chart. Four summary statistics do not
                need marks — a stat row reads faster and cannot mislead. */}
            <figure className="surface no-blur rounded-card p-4">
              <figcaption className="mb-3">
                <h3 className="text-body font-semibold text-paper">Latency</h3>
                <p className="mt-0.5 text-meta leading-snug text-dim">
                  Suite-wide, from the same run. The two-path split below is measured from this session&apos;s stream.
                </p>
              </figcaption>
              <dl className="grid grid-cols-4 gap-2">
                {(
                  [
                    ['mean', metrics.latency.meanMs],
                    ['p50', metrics.latency.p50Ms],
                    ['p95', metrics.latency.p95Ms],
                    ['max', metrics.latency.maxMs],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="surface-raised no-blur rounded-field px-2 py-2.5 text-center">
                    <dd className="num text-lg font-semibold text-paper">{formatLatency(v)}</dd>
                    <dt className="mt-0.5 text-meta text-dim">{k}</dt>
                  </div>
                ))}
              </dl>

              <div className="mt-4 space-y-2">
                <PathRow
                  icon={Zap}
                  label="Rule fast path"
                  count={rule.length}
                  total={actions.length}
                  avg={avg(rule)}
                  color={DECISION_FILL.allow}
                />
                <PathRow
                  icon={Brain}
                  label="LLM judge"
                  count={judge.length}
                  total={actions.length}
                  avg={avg(judge)}
                  color={DECISION_FILL.escalate}
                />
              </div>
              <p className="mt-2.5 flex items-start gap-1.5 text-meta leading-snug text-dim">
                <Timer className="mt-px h-3 w-3 shrink-0" />
                Path attribution in mock mode is a presentational approximation — the eval report does not record which
                layer answered. In live mode it is the gateway&apos;s own <code className="font-mono">decided_by</code>{' '}
                field.
              </p>
            </figure>
          </div>

          <p className="mt-5 text-meta leading-relaxed text-dim">
            Derived from <code className="font-mono text-muted">{provenance.scenariosFile}</code> and{' '}
            <code className="font-mono text-muted">{provenance.reportFile}</code> · {provenance.scenarioCount} scenarios
            · fixtures generated {provenance.generatedAt.slice(0, 16).replace('T', ' ')}.
          </p>
        </>
      )}
    </div>
  );
}

function Fig({ label, value, tone, hint }: { label: string; value: string; tone: 'allow' | 'block' | 'muted'; hint?: string }) {
  const color = { allow: 'text-allow', block: 'text-block', muted: 'text-paper' }[tone];
  return (
    <div>
      <dt className="text-meta uppercase tracking-wider text-dim">{label}</dt>
      <dd className={cn('num mt-1 text-2xl font-semibold leading-none', color)}>{value}</dd>
      {hint && <p className="mt-1 text-meta text-dim">{hint}</p>}
    </div>
  );
}

function PathRow({
  icon: Icon,
  label,
  count,
  total,
  avg,
  color,
}: {
  icon: React.ElementType;
  label: string;
  count: number;
  total: number;
  avg: number;
  color: string;
}) {
  const w = total ? (count / total) * 100 : 0;
  return (
    <div className="surface-raised no-blur rounded-field px-2.5 py-2">
      <div className="flex items-center gap-2 text-meta">
        <Icon className="h-3 w-3" style={{ color }} strokeWidth={2.4} />
        <span className="text-paper">{label}</span>
        <span className="num ml-auto text-muted">
          {count} calls · {avg ? formatLatency(avg) : '—'} avg
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-pill bg-white/10">
        <div className="h-full transition-[width] duration-300" style={{ width: `${w}%`, background: color }} />
      </div>
    </div>
  );
}
