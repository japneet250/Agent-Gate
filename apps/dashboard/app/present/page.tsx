'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ShieldCheck, Bot, AlertTriangle } from 'lucide-react';
import { useMetrics } from '@/lib/data';
import { pct } from '@/lib/utils';

/**
 * Layer 6 — the presenter opener.
 *
 * Three beats: the problem, the mechanism, the measurement. Then it hands off
 * to the Shield. Everything here is static chrome, so glass and heavy motion
 * are appropriate — there is no live-updating data on this screen.
 */
const BEATS = [
  {
    kicker: 'The problem',
    title: 'AI agents are taking real actions with nothing in the way.',
    body: 'They send email, move money, and run SQL against production. Between the model deciding and the tool executing, there is no checkpoint — no firewall, no audit, no human.',
    icon: Bot,
    tone: 'text-block',
  },
  {
    kicker: 'The mechanism',
    title: 'AgentGate sits in that gap.',
    body: 'Every tool call is intercepted before it executes. A rule table answers the obvious cases in under ten milliseconds; everything else goes to an LLM judge with the policy corpus retrieved alongside it. Allow, block, or escalate to a human.',
    icon: ShieldCheck,
    tone: 'text-accent',
  },
  {
    kicker: 'The measurement',
    title: 'And we measured it, honestly.',
    body: 'A hundred labelled scenarios, scored against the real engine. We publish what it gets wrong as readily as what it gets right — including the class it is currently bad at.',
    icon: AlertTriangle,
    tone: 'text-escalate',
  },
] as const;

export default function PresentPage() {
  const [beat, setBeat] = useState(0);
  const { metrics } = useMetrics();
  const b = BEATS[beat];
  const last = beat === BEATS.length - 1;

  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1100px] flex-col justify-center px-6 py-10">
      <AnimatePresence mode="wait">
        <motion.section
          key={beat}
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -14, filter: 'blur(6px)' }}
          transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="flex items-center gap-2 text-meta font-semibold uppercase tracking-[0.18em] text-dim">
            <b.icon className={`h-4 w-4 ${b.tone}`} strokeWidth={2.2} />
            {b.kicker}
          </span>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.12] tracking-tight text-paper md:text-5xl">
            {b.title}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">{b.body}</p>

          {last && metrics && (
            <div className="glass glass-edge mt-8 inline-flex flex-wrap items-end gap-x-9 gap-y-4 rounded-panel px-6 py-5">
              <Fig value={pct(metrics.accuracy, 1)} label="decision accuracy" />
              <Fig value={pct(metrics.perClass.block.recall, 0)} label="block recall" tone="text-allow" />
              <Fig value={pct(metrics.perClass.escalate.recall, 0)} label="escalate recall" tone="text-block" />
              <p className="max-w-[16rem] text-meta leading-relaxed text-dim">
                The third number is bad, and it is on the slide. It is the calibration work still in front of us.
              </p>
            </div>
          )}
        </motion.section>
      </AnimatePresence>

      <nav className="mt-12 flex items-center gap-3">
        {BEATS.map((_, i) => (
          <button
            key={i}
            onClick={() => setBeat(i)}
            aria-label={`Go to beat ${i + 1}`}
            className={`h-1 rounded-pill transition-all duration-300 ${
              i === beat ? 'w-10 bg-paper' : 'w-5 bg-white/20 hover:bg-white/35'
            }`}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          {beat > 0 && (
            <button
              onClick={() => setBeat((n) => n - 1)}
              className="rounded-field border border-white/10 px-3 py-2 text-body text-muted transition-colors hover:border-white/20 hover:text-paper"
            >
              Back
            </button>
          )}
          {last ? (
            <Link
              href="/"
              className="flex items-center gap-2 rounded-field bg-paper px-4 py-2 text-body font-semibold text-ink-950 transition-transform duration-150 hover:-translate-y-px active:scale-[0.97]"
            >
              Open the Shield
              <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
            </Link>
          ) : (
            <button
              onClick={() => setBeat((n) => n + 1)}
              className="flex items-center gap-2 rounded-field bg-paper px-4 py-2 text-body font-semibold text-ink-950 transition-transform duration-150 hover:-translate-y-px active:scale-[0.97]"
            >
              Next
              <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </nav>
    </div>
  );
}

const Fig = ({ value, label, tone = 'text-paper' }: { value: string; label: string; tone?: string }) => (
  <div>
    <div className={`num text-3xl font-semibold leading-none ${tone}`}>{value}</div>
    <div className="mt-1.5 text-meta uppercase tracking-wider text-dim">{label}</div>
  </div>
);
