'use client';

import { memo } from 'react';
import { motion } from 'framer-motion';
import { Ban, Check, TriangleAlert, Zap, Brain, AlertCircle } from 'lucide-react';
import type { EvaluatedAction } from '@/lib/data/types';
import { cn, DECISION_LABEL, decisionClasses, formatLatency, formatTime, signalsIn, summariseArgs } from '@/lib/utils';

const ICON = { allow: Check, block: Ban, escalate: TriangleAlert };

/**
 * One evaluated tool call.
 *
 * DATA SURFACE — the hard rule applies. `.surface` is opaque with no
 * backdrop-filter, because this text updates live and has to be readable from
 * the back of a room. The only motion is a one-shot entry transform, which the
 * compositor handles without repainting text.
 *
 * memo() is load-bearing: during the 30-action burst the parent re-renders on
 * every tick, and without this every visible card re-renders with it.
 */
export const ActionCard = memo(function ActionCard({
  item,
  onSelect,
  index = 0,
  compact = false,
}: {
  item: EvaluatedAction;
  onSelect?: (a: EvaluatedAction) => void;
  index?: number;
  compact?: boolean;
}) {
  const { action, result, path } = item;
  const c = decisionClasses(result.decision);
  const Icon = ICON[result.decision];
  const signals = signalsIn(action.toolArgs);
  const isBlock = result.decision === 'block';

  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: -10, scale: 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        // impeccable.style: 380ms, ease-out with a small spring overshoot.
        type: 'spring',
        stiffness: 420,
        damping: 34,
        mass: 0.7,
        delay: Math.min(index, 4) * 0.02,
      }}
      onClick={() => onSelect?.(item)}
      className={cn(
        'will-animate group relative cursor-pointer rounded-card px-3.5 py-3 transition-[border-color,transform] duration-150',
        'surface no-blur hover:-translate-y-px',
        c.rail,
        isBlock && 'tint-block',
        result.decision === 'escalate' && 'tint-escalate',
      )}
    >
      {/* A block gets one weighted pulse. One-shot, transform+opacity only. */}
      {isBlock && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-pulse-ring rounded-card ring-2 ring-block/70"
        />
      )}

      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-field',
            isBlock ? 'bg-block/15' : result.decision === 'allow' ? 'bg-allow/15' : 'bg-escalate/15',
          )}
        >
          <Icon className={cn('h-3.5 w-3.5', c.text)} strokeWidth={2.6} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn('pill', c.bg, 'text-ink-950')}>{DECISION_LABEL[result.decision]}</span>
            <code className="truncate font-mono text-body font-semibold text-paper">{action.toolName}</code>
            <span className="text-meta text-dim">{action.agentId}</span>

            <span className="ml-auto flex items-center gap-2.5">
              {signals.map((s) => (
                <span key={s} className="pill border border-block/40 bg-block/10 text-block">
                  {s}
                </span>
              ))}
              <span
                title={path === 'rule' ? 'Rule table — no model call' : 'LLM judge'}
                className={cn(
                  'pill border',
                  path === 'rule'
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-white/12 bg-white/[0.05] text-muted',
                )}
              >
                {path === 'rule' ? <Zap className="h-3 w-3" /> : <Brain className="h-3 w-3" />}
                {formatLatency(result.latencyMs)}
              </span>
            </span>
          </div>

          {!compact && (
            <p className="mt-1.5 truncate font-mono text-meta text-muted">{summariseArgs(action.toolArgs)}</p>
          )}

          <p className={cn('mt-1.5 text-body leading-snug', isBlock ? 'text-paper' : 'text-muted')}>
            {result.reasoning || '—'}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-dim">
            <span className="num">
              risk <span className={cn('font-semibold', c.text)}>{result.riskScore}</span>/100
            </span>
            {result.violatedPolicy && <span className="truncate">· {result.violatedPolicy}</span>}
            <span className="num ml-auto">{formatTime(action.timestamp)}</span>
          </div>

          {/* Honest divergence marker: the engine disagreed with the suite's
              ground-truth label. Shown, never hidden — it is the measured gap. */}
          {item.diverges && item.expected && (
            <p className="mt-2 flex items-center gap-1.5 rounded-field border border-escalate/25 bg-escalate/[0.07] px-2 py-1 text-meta text-escalate">
              <AlertCircle className="h-3 w-3 shrink-0" strokeWidth={2.4} />
              Eval label says <strong className="font-semibold">{item.expected}</strong> — engine returned{' '}
              <strong className="font-semibold">{result.decision}</strong>
            </p>
          )}
        </div>
      </div>
    </motion.article>
  );
});
