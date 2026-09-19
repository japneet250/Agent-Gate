'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Inbox, Info } from 'lucide-react';
import { useActionFeed, useMetrics } from '@/lib/data';
import type { EvaluatedAction } from '@/lib/data/types';
import { TraceDrawer } from '@/components/feed/trace-drawer';
import { cn, formatTime, pct, summariseArgs } from '@/lib/utils';

/**
 * Layer 5 — the human review queue.
 *
 * This is the third leg of allow/block/escalate, and it is the layer most at
 * risk of dishonesty: a queue looks impressive full, and the engine currently
 * escalates about 9% of what the suite says it should. So the queue shows
 * exactly what escalated and nothing else, and when it is thin it says why
 * instead of padding itself.
 */
export default function ReviewPage() {
  const { actions } = useActionFeed();
  const { metrics } = useMetrics();
  const [resolved, setResolved] = useState<Record<string, 'approved' | 'denied'>>({});
  const [selected, setSelected] = useState<EvaluatedAction | null>(null);

  const queue = useMemo(
    () => actions.filter((a) => a.result.decision === 'escalate' && !resolved[a.action.id]),
    [actions, resolved],
  );
  const done = Object.keys(resolved).length;

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-6">
      <header className="mb-5 flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-title">Human review</h1>
          <p className="mt-0.5 text-body text-muted">
            Actions the engine would not decide alone. A firewall that cannot judge should not allow.
          </p>
        </div>
        <div className="ml-auto flex gap-6">
          <Stat label="Awaiting" value={queue.length} />
          <Stat label="Resolved" value={done} />
        </div>
      </header>

      {/* The honest caveat, always present, not a tooltip. */}
      {metrics && (
        <p className="mb-4 flex items-start gap-2 rounded-field border border-escalate/25 bg-escalate/[0.06] px-3 py-2 text-meta leading-relaxed text-muted">
          <Info className="mt-px h-3.5 w-3.5 shrink-0 text-escalate" strokeWidth={2.2} />
          <span>
            Escalate recall is currently{' '}
            <strong className="text-escalate">{pct(metrics.perClass.escalate.recall, 1)}</strong> — the engine returns{' '}
            <em>escalate</em> for {metrics.confusion.escalate.escalate} of {metrics.perClass.escalate.support} scenarios
            the suite labels that way, blocking {metrics.confusion.escalate.block} of them outright. This queue is
            therefore thinner than the product intends. It is not padded to compensate.
          </span>
        </p>
      )}

      <div className="space-y-2">
        <AnimatePresence initial={false} mode="popLayout">
          {queue.map((a) => (
            <motion.article
              key={a.action.id}
              layout="position"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}
              className="surface no-blur rail-escalate tint-escalate rounded-card p-4"
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-body font-semibold text-paper">{a.action.toolName}</code>
                    <span className="text-meta text-dim">
                      {a.action.agentId} · {formatTime(a.action.timestamp)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-meta text-muted">{summariseArgs(a.action.toolArgs, 120)}</p>
                  <p className="mt-1.5 text-body leading-snug text-paper">{a.result.reasoning}</p>
                  {a.result.violatedPolicy && (
                    <p className="mt-1 text-meta text-escalate">{a.result.violatedPolicy}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => setSelected(a)}
                    className="rounded-field border border-white/10 px-2.5 py-1.5 text-meta text-muted transition-colors hover:border-white/20 hover:text-paper focus-visible:ring-focus"
                  >
                    Trace
                  </button>
                  <Action
                    onClick={() => setResolved((r) => ({ ...r, [a.action.id]: 'denied' }))}
                    icon={X}
                    label="Deny"
                    tone="block"
                  />
                  <Action
                    onClick={() => setResolved((r) => ({ ...r, [a.action.id]: 'approved' }))}
                    icon={Check}
                    label="Approve"
                    tone="allow"
                  />
                </div>
              </div>
            </motion.article>
          ))}
        </AnimatePresence>

        {queue.length === 0 && (
          <div className="surface no-blur rounded-card px-5 py-16 text-center">
            <Inbox className="mx-auto mb-3 h-6 w-6 text-ink-500" strokeWidth={1.8} />
            <p className="text-body text-muted">
              {done > 0 ? 'Queue clear — every escalation has been resolved.' : 'Nothing awaiting review yet.'}
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-meta leading-relaxed text-dim">
              Escalations arrive as the feed streams. An empty queue here means the engine escalated nothing, not that
              nothing was risky.
            </p>
          </div>
        )}
      </div>

      <TraceDrawer item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div>
    <div className="num text-2xl font-semibold leading-none text-paper">{value}</div>
    <div className="mt-1 text-meta uppercase tracking-wider text-dim">{label}</div>
  </div>
);

function Action({
  onClick,
  icon: Icon,
  label,
  tone,
}: {
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  tone: 'allow' | 'block';
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-field border px-2.5 py-1.5 text-meta font-semibold transition-all duration-150 active:scale-[0.96] focus-visible:ring-focus',
        tone === 'allow'
          ? 'border-allow/40 bg-allow/10 text-allow hover:bg-allow/20'
          : 'border-block/40 bg-block/10 text-block hover:bg-block/20',
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.6} />
      {label}
    </button>
  );
}
