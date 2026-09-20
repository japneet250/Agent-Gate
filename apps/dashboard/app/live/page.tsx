'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Plug, Building2, Bot } from 'lucide-react';
import { PERSONAS } from '@/lib/personas';
import { AgentTerminal } from '@/components/demo/terminal';
import { FlowDiagram, McpDiagram, HttpDiagram } from '@/components/demo/flow';
import { cn } from '@/lib/utils';

/**
 * The stage.
 *
 * One agent at a time, chosen from a rail. Three terminals side by side looked
 * busy and made each one too narrow to read from across a table — and a demo
 * only ever has one agent in play anyway. The other two stay mounted and keep
 * their history, so switching back mid-demo shows what that agent already did.
 *
 * The agents are examples. The headline says what the product is, not how many
 * terminals happen to be on the screen.
 */
export default function LivePage() {
  const [activeId, setActiveId] = useState(PERSONAS[0].id);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const bump = useCallback(
    (id: string) => setCounts((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 })),
    [],
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      <section className="mb-5 grid items-center gap-6 lg:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <header>
          <p className="mb-2 flex items-center gap-1.5 text-meta uppercase tracking-[0.12em] text-accent">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            Live
          </p>
          <h1 className="text-[2rem] font-semibold leading-[1.15] tracking-tight text-paper">
            A firewall between
            <br />
            your AI agents and
            <br />
            the real world.
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
            Agents email, move money and run SQL. Every call is intercepted{' '}
            <span className="text-paper">before it runs</span>.
          </p>
        </header>

        <FlowDiagram className="h-auto w-full max-w-[44rem] justify-self-end" />
      </section>

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

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-body font-semibold text-paper">Try it on a live agent</h2>
          <p className="text-meta text-dim">
            Three examples. Type anything — try to make one leak a record or overspend.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {total > 0 && (
            <span className="rounded-pill border border-white/10 px-2.5 py-1 font-mono text-meta text-muted">
              {total} evaluated
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        {/* The rail. Each card says what the agent is and what it can reach —
            the two things you need before deciding what to ask it. */}
        <nav className="flex gap-3 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {PERSONAS.map((p) => {
            const active = p.id === activeId;
            return (
              <button
                key={p.id}
                onClick={() => setActiveId(p.id)}
                aria-pressed={active}
                className={cn(
                  'surface no-blur min-w-[15rem] shrink-0 rounded-card border-l-2 p-3 text-left transition-all duration-150 lg:min-w-0',
                  active ? 'opacity-100' : 'opacity-55 hover:opacity-85',
                )}
                style={{
                  borderLeftColor: active ? p.accent : 'transparent',
                  boxShadow: active ? `0 0 0 1px ${p.glow}` : undefined,
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-field"
                    style={{ background: p.glow }}
                  >
                    <Bot className="h-3.5 w-3.5" style={{ color: p.accent }} strokeWidth={2.4} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-body font-semibold leading-tight text-paper">{p.company}</p>
                    <p className="truncate text-meta leading-tight text-dim">{p.role}</p>
                  </div>
                  {counts[p.id] > 0 && (
                    <span className="ml-auto shrink-0 rounded-pill border border-white/10 px-1.5 font-mono text-meta text-dim">
                      {counts[p.id]}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.tools.map((t) => (
                    <span
                      key={t.name}
                      className="rounded-pill border border-white/10 px-1.5 py-0.5 font-mono text-meta text-dim"
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </nav>

        {/* All three stay mounted so history survives a switch. */}
        <div>
          {PERSONAS.map((p) => (
            <div key={p.id} className={p.id === activeId ? 'block' : 'hidden'}>
              <AgentTerminal persona={p} onActivity={() => bump(p.id)} />
            </div>
          ))}
        </div>
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
