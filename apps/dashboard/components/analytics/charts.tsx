'use client';

import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Table2, BarChart3 } from 'lucide-react';
import type { BenchmarkMetrics, Decision } from '@/lib/data/types';
import { AXIS, DECISION_FILL, DECISION_ORDER, SEQUENTIAL, sequentialStep } from '@/lib/chart-tokens';
import { cn, DECISION_LABEL, pct } from '@/lib/utils';

/* ------------------------------------------------------------------ shared */

/** Every chart gets a table view. Identity is never carried by colour alone. */
function Figure({
  title,
  note,
  table,
  children,
}: {
  title: string;
  note?: string;
  table: React.ReactNode;
  children: React.ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <figure className="surface no-blur rounded-card p-4">
      <figcaption className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold text-paper">{title}</h3>
          {note && <p className="mt-0.5 text-meta leading-snug text-dim">{note}</p>}
        </div>
        <button
          onClick={() => setView((v) => (v === 'chart' ? 'table' : 'chart'))}
          aria-label={view === 'chart' ? 'Show as table' : 'Show as chart'}
          className="shrink-0 rounded-field border border-white/10 p-1.5 text-muted transition-colors hover:border-white/20 hover:text-paper focus-visible:ring-focus"
        >
          {view === 'chart' ? <Table2 className="h-3.5 w-3.5" /> : <BarChart3 className="h-3.5 w-3.5" />}
        </button>
      </figcaption>
      {view === 'chart' ? children : <div className="overflow-x-auto">{table}</div>}
    </figure>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-meta text-muted">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function TipShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="surface-raised no-blur rounded-field px-2.5 py-2 text-meta shadow-panel">{children}</div>
  );
}

/* ----------------------------------------------------- per-class metrics */

/**
 * Grouped bars, one group per metric, one bar per decision class.
 *
 * Colour encodes the CLASS (the entity), not the metric — so a filter that
 * removes a class never repaints the survivors. The metric is encoded by
 * position, which needs no second palette.
 */
export function PerClassChart({ metrics }: { metrics: BenchmarkMetrics }) {
  const data = (['precision', 'recall', 'f1'] as const).map((k) => ({
    metric: k === 'f1' ? 'F1' : k[0].toUpperCase() + k.slice(1),
    ...Object.fromEntries(DECISION_ORDER.map((d) => [d, metrics.perClass[d]?.[k] ?? 0])),
  }));

  return (
    <Figure
      title="Per-class precision, recall and F1"
      note="Escalate recall is the weak axis — the engine rarely lands in the escalate band."
      table={
        <table className="w-full text-meta">
          <thead>
            <tr className="text-left text-dim">
              <th className="py-1 pr-4 font-medium">Class</th>
              <th className="py-1 pr-4 font-medium">Support</th>
              <th className="py-1 pr-4 font-medium">Precision</th>
              <th className="py-1 pr-4 font-medium">Recall</th>
              <th className="py-1 font-medium">F1</th>
            </tr>
          </thead>
          <tbody className="num">
            {DECISION_ORDER.map((d) => (
              <tr key={d} className="border-t border-white/[0.06]">
                <td className="py-1.5 pr-4 text-paper">{DECISION_LABEL[d]}</td>
                <td className="py-1.5 pr-4 text-muted">{metrics.perClass[d].support}</td>
                <td className="py-1.5 pr-4 text-muted">{pct(metrics.perClass[d].precision)}</td>
                <td className="py-1.5 pr-4 text-muted">{pct(metrics.perClass[d].recall)}</td>
                <td className="py-1.5 text-muted">{metrics.perClass[d].f1.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 14, right: 4, bottom: 0, left: -18 }} barGap={2} barCategoryGap="26%">
            <CartesianGrid stroke={AXIS.grid} vertical={false} />
            <XAxis dataKey="metric" tick={{ fill: AXIS.tick, fontSize: 12 }} axisLine={{ stroke: AXIS.line }} tickLine={false} />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => `${v * 100}`}
              tick={{ fill: AXIS.tick, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TipShell>
                    <div className="mb-1 font-semibold text-paper">{label}</div>
                    {payload.map((p) => (
                      <div key={p.dataKey as string} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
                        <span className="text-muted">{DECISION_LABEL[p.dataKey as Decision]}</span>
                        <span className="num ml-auto text-paper">{((p.value as number) * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </TipShell>
                ) : null
              }
            />
            {DECISION_ORDER.map((d) => (
              <Bar key={d} dataKey={d} fill={DECISION_FILL[d]} radius={[4, 4, 0, 0]} maxBarSize={30}>
                <LabelList
                  dataKey={d}
                  position="top"
                  offset={6}
                  formatter={(v: number) => (v < 0.2 ? `${(v * 100).toFixed(0)}%` : '')}
                  style={{ fill: '#9aa4b8', fontSize: 11 }}
                />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={DECISION_ORDER.map((d) => ({ label: DECISION_LABEL[d], color: DECISION_FILL[d] }))} />
    </Figure>
  );
}

/* ------------------------------------------------------ confusion matrix */

/** Magnitude → one hue, light to dark. Counts are printed in every cell, so the
 *  matrix is readable with no colour perception at all. */
export function ConfusionMatrix({ metrics }: { metrics: BenchmarkMetrics }) {
  const max = Math.max(...DECISION_ORDER.flatMap((a) => DECISION_ORDER.map((b) => metrics.confusion[a][b])));

  return (
    <Figure
      title="Confusion matrix"
      note="Rows are the eval label, columns the engine's decision. The escalate row is where the misses are."
      table={
        <table className="w-full text-meta">
          <tbody className="num">
            {DECISION_ORDER.map((a) => (
              <tr key={a} className="border-t border-white/[0.06]">
                <td className="py-1.5 pr-4 text-paper">{DECISION_LABEL[a]}</td>
                {DECISION_ORDER.map((b) => (
                  <td key={b} className="py-1.5 pr-4 text-muted">
                    →{DECISION_LABEL[b]} {metrics.confusion[a][b]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px]">
          <thead>
            <tr>
              <th />
              {DECISION_ORDER.map((b) => (
                <th key={b} className="pb-1 text-meta font-medium text-dim">
                  {DECISION_LABEL[b]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DECISION_ORDER.map((a) => (
              <tr key={a}>
                <th className="pr-2 text-right text-meta font-medium text-dim">{DECISION_LABEL[a]}</th>
                {DECISION_ORDER.map((b) => {
                  const v = metrics.confusion[a][b];
                  const bg = sequentialStep(v, max);
                  const diagonal = a === b;
                  return (
                    <td
                      key={b}
                      title={`label ${a} → engine ${b}: ${v}`}
                      className={cn(
                        'num h-14 rounded-field text-center align-middle text-body font-semibold tabular-nums',
                        bg ? 'text-paper' : 'text-dim',
                        diagonal && 'ring-1 ring-inset ring-white/25',
                      )}
                      style={{ background: bg ?? 'rgba(255,255,255,0.03)' }}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-2 text-meta text-dim">
        <span>0</span>
        <span className="flex gap-[2px]">
          {SEQUENTIAL.map((c) => (
            <span key={c} className="h-2 w-6 rounded-[2px]" style={{ background: c }} />
          ))}
        </span>
        <span>{max}</span>
        <span className="ml-2">· outlined cells are correct decisions</span>
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------- category accuracy */

export function CategoryChart({ metrics }: { metrics: BenchmarkMetrics }) {
  const data = metrics.byCategory.map((c) => ({ ...c, label: `${c.category} (${c.n})` }));

  return (
    <Figure
      title="Accuracy by scenario category"
      note="One series — the title names it, so no legend box is needed."
      table={
        <table className="w-full text-meta">
          <tbody className="num">
            {data.map((c) => (
              <tr key={c.category} className="border-t border-white/[0.06]">
                <td className="py-1.5 pr-4 text-paper">{c.category}</td>
                <td className="py-1.5 pr-4 text-muted">n={c.n}</td>
                <td className="py-1.5 text-muted">{pct(c.accuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 2, right: 42, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={AXIS.grid} horizontal={false} />
            <XAxis
              type="number"
              domain={[0, 1]}
              tickFormatter={(v: number) => `${v * 100}`}
              tick={{ fill: AXIS.tick, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="category"
              width={78}
              tick={{ fill: AXIS.tick, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <TipShell>
                    <div className="font-semibold text-paper">{payload[0].payload.category}</div>
                    <div className="num text-muted">
                      {pct(payload[0].payload.accuracy)} of {payload[0].payload.n}
                    </div>
                  </TipShell>
                ) : null
              }
            />
            <Bar dataKey="accuracy" radius={[0, 4, 4, 0]} maxBarSize={22}>
              {data.map((c) => (
                <Cell
                  key={c.category}
                  fill={c.accuracy >= 0.75 ? DECISION_FILL.allow : c.accuracy >= 0.4 ? DECISION_FILL.escalate : DECISION_FILL.block}
                />
              ))}
              <LabelList
                dataKey="accuracy"
                position="right"
                offset={8}
                formatter={(v: number) => pct(v, 0)}
                style={{ fill: '#f2f4f8', fontSize: 12, fontWeight: 600 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-meta text-dim">
        Fill encodes the same value as the bar length (a threshold cue), not a separate variable.
      </p>
    </Figure>
  );
}
