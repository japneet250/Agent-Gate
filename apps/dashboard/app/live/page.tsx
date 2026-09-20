'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Plug, Building2 } from 'lucide-react';
import { PERSONAS } from '@/lib/personas';
import { AgentTerminal } from '@/components/demo/terminal';
import { FlowDiagram, McpDiagram, HttpDiagram } from '@/components/demo/flow';

/**
 * The stage.
 *
 * This screen is read from the back of a room in about ten seconds, so it is
 * built around one diagram and three terminals. Everything that was a paragraph
 * is now a picture or a six-word caption: a demo table is not a slide deck, and
 * the audience's attention belongs on the agents, not on prose about them.
 *
 * The three agents are fictional companies. Nothing else is — each terminal is
 * a real tool-calling loop whose every call goes through the real gateway.
 */
export default function LivePage() {
  const [decided, setDecided] = useState(0);
  const bump = useCallback(() => setDecided((n) => n + 1), []);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      <section className="mb-5 grid items-center gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <header>
          <p className="mb-2 flex items-center gap-1.5 text-meta uppercase tracking-[0.12em] text-accent">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            Live
          </p>
          <h1 className="text-[2rem] font-semibold leading-[1.15] tracking-tight text-paper">
            Three AI agents.
            <br />
            One firewall.
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
            They can email, move money and run SQL. Every call is intercepted{' '}
            <span className="text-paper">before it runs</span>.
          </p>
          <p className="mt-3 text-body text-paper">
            Type anything at them. Try to make one leak a record.
          </p>
        </header>

        <FlowDiagram className="h-auto w-full max-w-[42rem] justify-self-end" />
      </section>

      {/* How it is installed — two pictures, two captions, no prose. */}
      <section className="mb-6 grid gap-3 md:grid-cols-2">
        <Install
          icon={<Plug className="h-3.5 w-3.5" />}
          title="MCP gateway"
          caption="Point the agent at us instead of its tools. No code change."
          diagram={<McpDiagram />}
        />
        <Install
          icon={<Building2 className="h-3.5 w-3.5" />}
          title="Internal systems"
          caption="One POST before you execute. Any language, any stack."
          diagram={<HttpDiagram />}
        />
      </section>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-body font-semibold text-paper">Production agents</h2>
        <div className="flex items-center gap-2.5">
          {decided > 0 && (
            <span className="rounded-pill border border-white/10 px-2.5 py-1 font-mono text-meta text-muted">
              {decided} evaluated
            </span>
          )}
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-field border border-white/10 px-2.5 py-1.5 text-meta text-muted transition hover:border-white/25 hover:text-paper"
          >
            Security console
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {PERSONAS.map((p) => (
          <AgentTerminal key={p.id} persona={p} onActivity={bump} />
        ))}
      </div>

      <p className="mt-4 text-meta text-dim">
        Live decisions from the real engine — not a replay. Every verdict is written to the audit log.
      </p>
    </div>
  );
}

function Install({
  icon,
  title,
  caption,
  diagram,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  diagram: React.ReactNode;
}) {
  return (
    <section className="surface no-blur rounded-card p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-field bg-accent/12 text-accent">
          {icon}
        </span>
        <h3 className="text-body font-semibold text-paper">{title}</h3>
        <p className="min-w-0 flex-1 truncate text-meta text-muted">{caption}</p>
      </div>
      {diagram}
    </section>
  );
}
