'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Building2, Plug, ShieldCheck, Activity } from 'lucide-react';
import { PERSONAS } from '@/lib/personas';
import { AgentTerminal } from '@/components/demo/terminal';
import { cn } from '@/lib/utils';

/**
 * The stage.
 *
 * Three production agents at three companies, each with its own terminal, each
 * wired through the real gateway. The audience types the dangerous request
 * themselves — that is the whole trick. A scripted demo proves the script
 * works; a stranger's prompt getting refused proves the product works.
 *
 * Everything above the terminals exists to answer the two questions a judge
 * asks in the first ten seconds: what is this, and how would we install it.
 */
export default function LivePage() {
  const [decided, setDecided] = useState(0);
  const bump = useCallback(() => setDecided((n) => n + 1), []);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-7">
      <header className="mb-6 max-w-3xl">
        <p className="mb-1.5 flex items-center gap-1.5 text-meta uppercase tracking-wider text-accent">
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.4} />
          Live
        </p>
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-paper">
          Three AI agents. Three companies. One firewall between them and the real world.
        </h1>
        <p className="mt-2 text-body leading-relaxed text-muted">
          These agents can send email, move money and run SQL against production. Each one is a real
          tool-calling loop — the model chooses what to do, not a script. Every call it attempts is
          intercepted by AgentGate first and comes back <span className="text-allow">allowed</span>,{' '}
          <span className="text-block">blocked</span>, or{' '}
          <span className="text-escalate">held for a human</span>, with the policy it violated.
        </p>
        <p className="mt-2 text-body leading-relaxed text-muted">
          <span className="text-paper">Type whatever you like into any terminal.</span> Try to make one
          leak a record, overspend, or drop a table.
        </p>
      </header>

      {/* The two ways this actually gets installed. Asked in every conversation,
          so answered before it is asked. */}
      <section className="mb-7 grid gap-3 lg:grid-cols-2">
        <Path
          icon={<Plug className="h-4 w-4 text-accent" />}
          tag="Integration 1"
          title="MCP gateway"
          sub="Claude, Cursor, Codex, Windsurf — no code change"
          body="Point the agent at AgentGate instead of at its tools. It mirrors the upstream server, so the agent sees the same tools it always had. The agent never holds a credential for them — only AgentGate does — so it cannot route around the firewall."
          foot="agentgate → Zip's MCP server: 131 tools, 66 of them destructive"
        />
        <Path
          icon={<Building2 className="h-4 w-4 text-accent" />}
          tag="Integration 2"
          title="Internal systems"
          sub="Your own agents, over HTTP"
          body="One POST per action before you execute it. The three terminals below run this way: the agent decides, AgentGate rules on it, and only then would the tool run. Same engine, same policies, same audit trail as the MCP path."
          foot="POST /evaluate → { decision, riskScore, reasoning, violatedPolicy }"
        />
      </section>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-body font-semibold text-paper">Production agents</h2>
        <div className="flex items-center gap-3">
          {decided > 0 && (
            <span className="flex items-center gap-1.5 text-meta text-muted">
              <Activity className="h-3.5 w-3.5 text-allow" />
              {decided} action{decided === 1 ? '' : 's'} evaluated this session
            </span>
          )}
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-field border border-white/10 px-2.5 py-1.5 text-meta text-muted transition hover:border-white/25 hover:text-paper"
          >
            Watch the security console
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {PERSONAS.map((p) => (
          <AgentTerminal key={p.id} persona={p} onActivity={bump} />
        ))}
      </div>

      <p className="mt-5 max-w-3xl text-meta leading-relaxed text-dim">
        Every verdict above was written to the audit log and is visible on{' '}
        <Link href="/" className="text-muted underline underline-offset-2 hover:text-paper">
          the Shield
        </Link>
        , with the pipeline timings on{' '}
        <Link href="/analytics" className="text-muted underline underline-offset-2 hover:text-paper">
          Analytics
        </Link>
        . Nothing here is replayed: the risk scores, the reasons and the latencies are whatever the
        engine returned just now.
      </p>
    </div>
  );
}

function Path({
  icon,
  tag,
  title,
  sub,
  body,
  foot,
}: {
  icon: React.ReactNode;
  tag: string;
  title: string;
  sub: string;
  body: string;
  foot: string;
}) {
  return (
    <section className="glass glass-edge rounded-panel p-4">
      <p className="mb-1.5 text-meta uppercase tracking-wider text-dim">{tag}</p>
      <h3 className="flex items-center gap-2 text-body font-semibold text-paper">
        {icon}
        {title}
      </h3>
      <p className="mt-0.5 text-meta text-muted">{sub}</p>
      <p className="mt-2 text-body leading-relaxed text-muted">{body}</p>
      <code className="mt-2.5 block overflow-x-auto rounded-field bg-ink-900 px-2.5 py-1.5 font-mono text-meta text-dim">
        {foot}
      </code>
    </section>
  );
}
