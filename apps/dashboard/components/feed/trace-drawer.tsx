'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { X, Zap, Brain, FileText, GitBranch, Gavel, ShieldAlert } from 'lucide-react';
import type { EvaluatedAction } from '@/lib/data/types';
import { cn, DECISION_LABEL, decisionClasses, formatLatency, formatTime } from '@/lib/utils';

/**
 * Layer 2 — the evaluation trace.
 *
 * The panel FRAME is glass (static chrome). Everything inside that carries data
 * sits on `.surface`: opaque, no blur. Same rule as the feed.
 */
export function TraceDrawer({ item, onClose }: { item: EvaluatedAction | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {item && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-ink-950/70"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38, mass: 0.8 }}
            className="glass glass-edge fixed right-0 top-0 z-50 flex h-full w-full max-w-[34rem] flex-col border-y-0 border-r-0"
          >
            <Header item={item} onClose={onClose} />
            <div className="flex-1 overflow-y-auto px-5 pb-8">
              <Pipeline item={item} />
              <Section title="Attempted call" icon={FileText}>
                <pre className="surface no-blur overflow-x-auto rounded-field p-3 font-mono text-meta leading-relaxed text-paper">
                  {item.action.toolName}({JSON.stringify(item.action.toolArgs, null, 2)})
                </pre>
              </Section>

              <Section title="Judge reasoning" icon={Gavel}>
                <p className="surface no-blur rounded-field p-3 text-body leading-relaxed text-paper">
                  {item.result.reasoning || 'No reasoning recorded.'}
                </p>
              </Section>

              {item.result.violatedPolicy && (
                <Section title="Violated policy" icon={ShieldAlert}>
                  <p className="surface no-blur rounded-field border-l-2 border-l-block p-3 text-body font-semibold text-paper">
                    {item.result.violatedPolicy}
                  </p>
                </Section>
              )}

              {item.retrievedPolicies && item.retrievedPolicies.length > 0 && (
                <Section title="Retrieved policies" icon={GitBranch}>
                  <ul className="space-y-1.5">
                    {item.retrievedPolicies.map((p) => (
                      <li key={p.name} className="surface no-blur flex items-center gap-3 rounded-field px-3 py-2">
                        <span className="flex-1 text-body text-paper">{p.name}</span>
                        <span className="num text-meta text-muted">{p.score.toFixed(3)}</span>
                        <span className="h-1 w-16 overflow-hidden rounded-pill bg-white/10">
                          <span className="block h-full bg-accent" style={{ width: `${Math.min(100, p.score * 100)}%` }} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {item.patternNotes && item.patternNotes.length > 0 && (
                <Section title="Pattern detector" icon={GitBranch}>
                  <ul className="space-y-1.5">
                    {item.patternNotes.map((n, i) => (
                      <li key={i} className="surface no-blur rounded-field border-l-2 border-l-escalate p-3 text-body text-paper">
                        {n}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {item.scenarioId && (
                <Section title="Provenance" icon={FileText}>
                  <div className="surface no-blur space-y-1.5 rounded-field p-3 text-meta">
                    <Row k="Scenario" v={item.scenarioId} />
                    <Row k="Eval label" v={item.expected ?? '—'} />
                    <Row k="Engine decision" v={item.result.decision} />
                    {item.diverges && (
                      <p className="mt-2 rounded-field border border-escalate/30 bg-escalate/[0.08] px-2 py-1.5 text-escalate">
                        These disagree. This row is one of the measured mismatches behind the benchmark number — shown,
                        not hidden.
                      </p>
                    )}
                  </div>
                </Section>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Header({ item, onClose }: { item: EvaluatedAction; onClose: () => void }) {
  const c = decisionClasses(item.result.decision);
  return (
    <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('pill', c.bg, 'text-ink-950')}>{DECISION_LABEL[item.result.decision]}</span>
          <code className="truncate font-mono text-title">{item.action.toolName}</code>
        </div>
        <p className="mt-1 text-meta text-dim">
          {item.action.agentId} · session {item.action.sessionId} · {formatTime(item.action.timestamp)}
        </p>
      </div>
      <button
        onClick={onClose}
        aria-label="Close trace"
        className="rounded-field p-1.5 text-muted transition-colors hover:bg-white/[0.07] hover:text-paper focus-visible:ring-focus"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The pipeline, with the fast path told honestly: when the rule table answers,
 *  the judge never runs, and we draw it as skipped rather than pretending. */
function Pipeline({ item }: { item: EvaluatedAction }) {
  const ruled = item.path === 'rule';
  const steps = [
    { name: 'Gateway rules', icon: Zap, ran: true, note: ruled ? 'matched — decided here' : 'no match' },
    { name: 'Classifier', icon: GitBranch, ran: !ruled, note: item.category ?? '—' },
    { name: 'Policy retrieval', icon: FileText, ran: !ruled, note: `${item.retrievedPolicies?.length ?? 0} policies` },
    { name: 'LLM judge', icon: Brain, ran: !ruled, note: ruled ? 'skipped' : `risk ${item.result.riskScore}` },
    { name: 'Decision gate', icon: Gavel, ran: true, note: DECISION_LABEL[item.result.decision] },
  ];

  return (
    <Section title="Evaluation path" icon={GitBranch}>
      <div className="surface no-blur rounded-field p-3">
        <div className="mb-3 flex items-baseline gap-2">
          <span className={cn('num text-2xl font-semibold', ruled ? 'text-accent' : 'text-paper')}>
            {formatLatency(item.result.latencyMs)}
          </span>
          <span className="text-meta text-dim">
            {ruled ? 'rule fast path — no model call, no cost' : 'judge path — classifier + retrieval + LLM'}
          </span>
        </div>
        <ol className="space-y-1.5">
          {steps.map((s) => (
            <li
              key={s.name}
              className={cn('flex items-center gap-2.5 text-body', s.ran ? 'text-paper' : 'text-dim line-through')}
            >
              <s.icon className={cn('h-3.5 w-3.5 shrink-0', s.ran ? 'text-accent' : 'text-ink-500')} strokeWidth={2.2} />
              <span className="flex-1">{s.name}</span>
              <span className="text-meta text-muted no-underline">{s.note}</span>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wider text-dim">
        <Icon className="h-3 w-3" strokeWidth={2.4} />
        {title}
      </h3>
      {children}
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-4">
    <span className="text-dim">{k}</span>
    <span className="font-mono text-paper">{v}</span>
  </div>
);
