'use client';

import { Zap, Brain, ShieldCheck } from 'lucide-react';
import { useActionFeed } from '@/lib/data';
import { cn } from '@/lib/utils';

/**
 * What the firewall has actually done, this session.
 *
 * Computed from the gateway's own action feed — the same rows the Shield
 * renders — so every figure here describes decisions taken seconds ago by the
 * running system. Nothing is replayed and nothing is precomputed.
 *
 * This is the counterpart to the benchmark below it: the benchmark says how the
 * engine scores against labelled data, this says what it is doing right now.
 */
const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

export function LiveOperations() {
  const { actions } = useActionFeed();

  const counts = { allow: 0, escalate: 0, block: 0 };
  for (const a of actions) counts[a.result.decision]++;

  const rule = actions.filter((a) => a.path === 'rule');
  const judge = actions.filter((a) => a.path === 'judge');
  const lat = (xs: typeof actions) => [...xs.map((a) => a.result.latencyMs)].sort((x, y) => x - y);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const ruleLat = lat(rule);
  const judgeLat = lat(judge);
  const stopped = counts.block + counts.escalate;

  return (
    <section className="surface no-blur rounded-card p-5">
      <header className="mb-4">
        <h2 className="flex items-center gap-2 text-body font-semibold text-paper">
          <ShieldCheck className="h-4 w-4 text-allow" />
          Live operations
          <span className="rounded-pill bg-allow/10 px-2 py-0.5 text-meta font-normal text-allow">
            live · gateway
          </span>
        </h2>
        <p className="mt-1 text-meta text-dim">
          Every action the gateway has decided this session, as it decided it.
        </p>
      </header>

      {actions.length === 0 ? (
        <p className="text-body text-muted">
          Nothing has come through yet. Fire an agent at it —{' '}
          <code className="font-mono text-meta text-paper">./fire.sh all</code>
        </p>
      ) : (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Evaluated" value={String(actions.length)} />
            <Stat label="Allowed" value={String(counts.allow)} tone="allow" />
            <Stat label="Blocked" value={String(counts.block)} tone="block" />
            <Stat label="Escalated" value={String(counts.escalate)} tone="escalate" />
          </dl>

          <div className="mb-4 flex h-2 w-full overflow-hidden rounded-pill bg-ink-900">
            {(['allow', 'escalate', 'block'] as const).map((d) =>
              counts[d] > 0 ? (
                <div
                  key={d}
                  className={cn(
                    'h-full transition-all duration-500',
                    d === 'allow' && 'bg-allow',
                    d === 'escalate' && 'bg-escalate',
                    d === 'block' && 'bg-block',
                  )}
                  style={{ width: `${(counts[d] / actions.length) * 100}%` }}
                />
              ) : null,
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Path
              icon={<Zap className="h-3.5 w-3.5 text-allow" />}
              label="Fast path — rules"
              n={rule.length}
              meanMs={mean(ruleLat)}
              p95Ms={percentile(ruleLat, 0.95)}
              note="no model call, no cost"
            />
            <Path
              icon={<Brain className="h-3.5 w-3.5 text-accent" />}
              label="Slow path — judge"
              n={judge.length}
              meanMs={mean(judgeLat)}
              p95Ms={percentile(judgeLat, 0.95)}
              note="RAG + gpt-4o"
            />
          </div>

          <p className="mt-4 text-meta leading-relaxed text-dim">
            {stopped} of {actions.length} actions were refused or held for a human.
            {rule.length > 0 && judge.length > 0 && (
              <>
                {' '}
                The fast path answered {Math.round((rule.length / actions.length) * 100)}% of them without
                touching a model.
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}

function Path({
  icon,
  label,
  n,
  meanMs,
  p95Ms,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  n: number;
  meanMs: number;
  p95Ms: number;
  note: string;
}) {
  const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms < 10 ? ms.toFixed(2) : Math.round(ms)}ms`);
  return (
    <div className="rounded-field border border-white/10 p-3">
      <div className="flex items-center gap-1.5 text-meta text-paper">
        {icon}
        {label}
      </div>
      <p className="mt-1 font-mono text-body text-paper">
        {n === 0 ? '—' : fmt(meanMs)}
        {n > 0 && <span className="text-meta text-dim"> · p95 {fmt(p95Ms)}</span>}
      </p>
      <p className="text-meta text-dim">
        {n} {n === 1 ? 'action' : 'actions'} · {note}
      </p>
    </div>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'muted' | 'allow' | 'block' | 'escalate' }) {
  const color = { muted: 'text-paper', allow: 'text-allow', block: 'text-block', escalate: 'text-escalate' }[tone];
  return (
    <div>
      <dt className="text-meta uppercase tracking-wider text-dim">{label}</dt>
      <dd className={cn('mt-0.5 font-mono text-title', color)}>{value}</dd>
    </div>
  );
}
