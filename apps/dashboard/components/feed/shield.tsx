'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Play, Pause, RotateCcw, Gauge, Activity } from 'lucide-react';
import { useActionFeed, useFrameRate } from '@/lib/data';
import type { EvaluatedAction } from '@/lib/data/types';
import { ActionCard } from './action-card';
import { TraceDrawer } from './trace-drawer';
import { cn, formatLatency } from '@/lib/utils';

/**
 * Layer 1 — The Shield.
 *
 * The right-hand screen of the two-screen demo. Everything here is a data
 * surface: opaque, high contrast, no backdrop-filter anywhere in the feed
 * column. The only glass is the stat rail's frame, which does not update on
 * every tick.
 */
export function Shield() {
  const { actions, running, mode, moments, start, pause, reset, jumpTo, burst } = useActionFeed();
  const [selected, setSelected] = useState<EvaluatedAction | null>(null);
  const [showFps, setShowFps] = useState(false);
  const fps = useFrameRate(showFps);

  const stats = useMemo(() => {
    const s = { allow: 0, block: 0, escalate: 0, rule: 0, judge: 0, ruleMs: 0, judgeMs: 0 };
    for (const a of actions) {
      s[a.result.decision] += 1;
      s[a.path] += 1;
      if (a.path === 'rule') s.ruleMs += a.result.latencyMs;
      else s.judgeMs += a.result.latencyMs;
    }
    return {
      ...s,
      total: actions.length,
      ruleAvg: s.rule ? s.ruleMs / s.rule : 0,
      judgeAvg: s.judge ? s.judgeMs / s.judge : 0,
    };
  }, [actions]);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        {/* ------------------------------------------------ feed column */}
        <section className="order-2 lg:order-1">
          <div className="mb-3 flex items-center gap-3">
            <h1 className="text-title">Live action feed</h1>
            <span className="flex items-center gap-1.5 text-meta text-dim">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  running ? 'bg-allow shadow-[0_0_8px_rgba(61,220,151,0.9)]' : 'bg-ink-500',
                )}
              />
              {running ? 'streaming' : 'paused'} · {stats.total} shown
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <Ctl onClick={running ? pause : start} icon={running ? Pause : Play} label={running ? 'Pause' : 'Play'} />
              <Ctl onClick={reset} icon={RotateCcw} label="Reset" />
              {mode === 'mock' && <Ctl onClick={burst} icon={Activity} label="Burst ×30" />}
              <Ctl
                onClick={() => setShowFps((v) => !v)}
                icon={Gauge}
                label={showFps ? `${fps} fps` : 'FPS'}
                active={showFps}
              />
            </div>
          </div>

          {/* The feed itself. No glass, no blur, opaque cards. */}
          <div className="space-y-2">
            <AnimatePresence initial={false} mode="popLayout">
              {actions.map((a, i) => (
                <ActionCard key={a.action.id} item={a} index={i} onSelect={setSelected} />
              ))}
            </AnimatePresence>

            {actions.length === 0 && (
              <div className="surface no-blur rounded-card px-5 py-16 text-center">
                <p className="text-body text-muted">
                  {mode === 'live'
                    ? 'No actions yet. The gateway has no /actions endpoint — see lib/data/live-provider.ts.'
                    : 'Press play to start the replay.'}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------ stat rail */}
        <aside className="order-1 space-y-4 lg:order-2">
          {/* Glass frame is fine: this panel updates at most once per action and
              its numbers sit on opaque chips inside. */}
          <div className="glass glass-edge rounded-panel p-4">
            <h2 className="mb-3 text-meta font-semibold uppercase tracking-wider text-dim">This session</h2>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Allowed" value={stats.allow} tone="allow" />
              <Stat label="Blocked" value={stats.block} tone="block" />
              <Stat label="Escalated" value={stats.escalate} tone="escalate" />
            </div>

            <div className="mt-4 space-y-2">
              <h3 className="text-meta font-semibold uppercase tracking-wider text-dim">Decision path</h3>
              <PathBar
                label="Rule table"
                count={stats.rule}
                total={stats.total}
                avg={stats.ruleAvg}
                className="bg-accent"
              />
              <PathBar
                label="LLM judge"
                count={stats.judge}
                total={stats.total}
                avg={stats.judgeAvg}
                className="bg-white/35"
              />
            </div>
          </div>

          {moments.length > 0 && (
            <div className="glass glass-edge rounded-panel p-4">
              <h2 className="mb-2.5 text-meta font-semibold uppercase tracking-wider text-dim">Jump to moment</h2>
              <div className="space-y-1.5">
                {moments.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => jumpTo(m.id)}
                    className="surface no-blur block w-full rounded-field px-3 py-2 text-left transition-transform duration-150 hover:-translate-y-px focus-visible:ring-focus"
                  >
                    <span className="block text-body font-semibold text-paper">{m.title}</span>
                    <span className="mt-0.5 block text-meta leading-snug text-muted">{m.subtitle}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      <TraceDrawer item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function Ctl({
  onClick,
  icon: Icon,
  label,
  active,
}: {
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-field border px-2 py-1 text-meta transition-all duration-150 active:scale-[0.96]',
        active
          ? 'border-accent/45 bg-accent/12 text-accent'
          : 'border-white/10 text-muted hover:border-white/20 hover:text-paper',
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2.4} />
      {label}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'allow' | 'block' | 'escalate' }) {
  const text = { allow: 'text-allow', block: 'text-block', escalate: 'text-escalate' }[tone];
  return (
    <div className="surface no-blur rounded-field px-2 py-2.5 text-center">
      <div className={cn('num text-2xl font-semibold leading-none', text)}>{value}</div>
      <div className="mt-1 text-meta text-dim">{label}</div>
    </div>
  );
}

function PathBar({
  label,
  count,
  total,
  avg,
  className,
}: {
  label: string;
  count: number;
  total: number;
  avg: number;
  className: string;
}) {
  const w = total ? (count / total) * 100 : 0;
  return (
    <div className="surface no-blur rounded-field px-2.5 py-2">
      <div className="flex items-baseline justify-between text-meta">
        <span className="text-paper">{label}</span>
        <span className="num text-muted">
          {count} · {avg ? formatLatency(avg) : '—'}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-pill bg-white/10">
        <div className={cn('h-full transition-[width] duration-300', className)} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}
