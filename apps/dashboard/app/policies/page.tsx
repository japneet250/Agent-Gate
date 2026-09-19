'use client';

import { useMemo, useState } from 'react';
import { Search, Sparkles, Shield, Zap, Brain } from 'lucide-react';
import { usePolicies, configuredMode } from '@/lib/data';
import { cn } from '@/lib/utils';

/**
 * Layer 4 — policy control.
 *
 * The list is the engine's REAL policy corpus, read from
 * packages/engine/src/agentgate_engine/policies/*.md at fixture-build time.
 *
 * Toggling and the natural-language composer are local-only. The engine has no
 * write endpoint, so nothing here reaches it — and the UI says so rather than
 * implying a round-trip that does not happen.
 */
export default function PoliciesPage() {
  const policies = usePolicies();
  const [q, setQ] = useState('');
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState('');
  const [proposed, setProposed] = useState<{ name: string; description: string }[]>([]);
  const mode = configuredMode();

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return policies;
    return policies.filter(
      (p) => p.name.toLowerCase().includes(t) || p.description.toLowerCase().includes(t) || p.id.includes(t),
    );
  }, [policies, q]);

  const enabledCount = policies.filter((p) => !off[p.id]).length;

  const propose = () => {
    const text = draft.trim();
    if (!text) return;
    // Deliberately naive: the first clause becomes a title. Wiring this to a
    // model would imply the engine accepts new policies at runtime; it does not.
    const name = text.split(/[.,]/)[0].slice(0, 58);
    setProposed((p) => [{ name: name.charAt(0).toUpperCase() + name.slice(1), description: text }, ...p]);
    setDraft('');
  };

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-6">
      <header className="mb-5 flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-title">Policies</h1>
          <p className="mt-0.5 text-body text-muted">
            The rules the judge retrieves against. {enabledCount} of {policies.length} enabled.
          </p>
        </div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dim" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter policies"
            className="surface no-blur w-64 rounded-field py-1.5 pl-8 pr-3 text-body text-paper placeholder:text-dim focus-visible:ring-focus"
          />
        </div>
      </header>

      {/* NL composer — glass frame is fine, it is static chrome. */}
      <section className="glass glass-edge mb-5 rounded-panel p-4">
        <h2 className="mb-2 flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wider text-dim">
          <Sparkles className="h-3 w-3" strokeWidth={2.4} />
          Describe a new policy
        </h2>
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && propose()}
            placeholder="No agent may email attachments to addresses outside the company domain"
            className="surface no-blur flex-1 rounded-field px-3 py-2 text-body text-paper placeholder:text-dim focus-visible:ring-focus"
          />
          <button
            onClick={propose}
            className="rounded-field bg-accent/90 px-3.5 py-2 text-body font-semibold text-ink-950 transition-all duration-150 hover:bg-accent active:scale-[0.96] focus-visible:ring-focus"
          >
            Propose
          </button>
        </div>
        <p className="mt-2 text-meta leading-relaxed text-dim">
          Proposals are held locally. The engine has no policy-write endpoint, so nothing here is sent to it — policies
          ship as markdown in <code className="font-mono">packages/engine/…/policies/</code>.
        </p>

        {proposed.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {proposed.map((p, i) => (
              <li key={i} className="surface no-blur rounded-field border-l-2 border-l-accent px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-body font-semibold text-paper">{p.name}</span>
                  <span className="pill border border-accent/40 bg-accent/10 text-accent">proposed · local only</span>
                </div>
                <p className="mt-0.5 text-meta leading-snug text-muted">{p.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {policies.length === 0 && (
        <div className="surface no-blur rounded-card px-5 py-14 text-center">
          <p className="text-body text-muted">
            {mode === 'live'
              ? 'Could not reach the engine at /policies.'
              : 'No policies found in the engine package when fixtures were generated.'}
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {filtered.map((p) => {
          const disabled = off[p.id];
          return (
            <li
              key={p.id}
              className={cn(
                'surface no-blur rounded-card p-3.5 transition-opacity duration-150',
                disabled && 'opacity-45',
              )}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-field bg-white/[0.06]">
                  <Shield className="h-3.5 w-3.5 text-muted" strokeWidth={2.2} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-body font-semibold text-paper">{p.name}</h3>
                    {p.severity && (
                      <span
                        className={cn(
                          'pill border',
                          p.severity === 'critical'
                            ? 'border-block/40 bg-block/10 text-block'
                            : p.severity === 'high'
                              ? 'border-escalate/40 bg-escalate/10 text-escalate'
                              : 'border-white/12 bg-white/[0.05] text-muted',
                        )}
                      >
                        {p.severity}
                      </span>
                    )}
                    {p.enforcedBy && (
                      <span className="pill border border-white/12 bg-white/[0.05] text-muted">
                        {p.enforcedBy === 'pattern_detector' ? (
                          <Zap className="h-3 w-3" />
                        ) : (
                          <Brain className="h-3 w-3" />
                        )}
                        {p.enforcedBy}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-body leading-snug text-muted">{p.description}</p>
                </div>

                <button
                  role="switch"
                  aria-checked={!disabled}
                  aria-label={`${disabled ? 'Enable' : 'Disable'} ${p.name}`}
                  onClick={() => setOff((s) => ({ ...s, [p.id]: !s[p.id] }))}
                  className={cn(
                    'mt-0.5 h-5 w-9 shrink-0 rounded-pill p-0.5 transition-colors duration-150 focus-visible:ring-focus',
                    disabled ? 'bg-white/12' : 'bg-allow/70',
                  )}
                >
                  <span
                    className={cn(
                      'block h-4 w-4 rounded-pill bg-paper transition-transform duration-150',
                      disabled ? 'translate-x-0' : 'translate-x-4',
                    )}
                  />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
