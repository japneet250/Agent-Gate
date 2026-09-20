'use client';

import { useMemo, useRef, useState } from 'react';
import { Search, Sparkles, Shield, Zap, Brain, Upload, FileText } from 'lucide-react';

/** What /api/policies reports back. A document usually yields several policies,
 *  and one bad clause must not hide the ones that did publish. */
type Kind = 'policy' | 'context';
type SubmitReport = {
  source: string;
  truncated?: boolean;
  created: number;
  rejected: number;
  /** Set when nothing could be extracted — the model's own explanation. */
  error?: string;
  hint?: string;
  results: (
    | { ok: true; id: string; name: string; markdown: string; kind: Kind }
    | { ok: false; error: string; markdown: string; kind: Kind }
  )[];
};
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
  const { policies, refresh } = usePolicies();
  const [q, setQ] = useState('');
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [report, setReport] = useState<SubmitReport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mode = configuredMode();

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return policies;
    return policies.filter(
      (p) => p.name.toLowerCase().includes(t) || p.description.toLowerCase().includes(t) || p.id.includes(t),
    );
  }, [policies, q]);

  const enabledCount = policies.filter((p) => !off[p.id]).length;

  /**
   * Publish for real.
   *
   * Free text or an uploaded document goes to /api/policies, which rewrites it
   * into the engine's policy format, validates it, stores it, and re-embeds the
   * corpus. It is retrievable by the RAG layer on the very next evaluation — so
   * a rule added here governs the next tool call an agent makes.
   */
  const send = async (init: RequestInit) => {
    if (busy) return;
    setBusy(true);
    setReport(null);
    try {
      const res = await fetch('/api/policies', { method: 'POST', ...init });
      const body = await res.json();
      if (body.results) {
        setReport(body as SubmitReport);
      } else {
        // Nothing was extracted, or the request failed outright. Carry the
        // explanation through rather than collapsing it to "rejected".
        setReport({
          source: body.source ?? 'typed',
          created: 0,
          rejected: 0,
          error: body.error ?? `failed (${res.status})`,
          hint: body.hint,
          results: [],
        });
      }
      if (body.created > 0) {
        setDraft('');
        // The list comes from the engine; refetch so a new policy appears where
        // every other policy does, not in a separate "pending" limbo.
        refresh?.();
      }
    } catch (err) {
      setReport({ source: 'typed', created: 0, rejected: 0, error: (err as Error).message, results: [] });
    } finally {
      setBusy(false);
    }
  };

  const submitText = () => {
    const text = draft.trim();
    if (text) void send({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  };

  const submitFile = (file: File) => {
    const form = new FormData();
    form.append('file', file);
    void send({ body: form });
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

      {/* Policy composer — glass frame is fine, it is static chrome. */}
      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) submitFile(f);
        }}
        className={cn(
          'glass glass-edge mb-5 rounded-panel p-4 transition-colors',
          dragging && 'ring-2 ring-accent',
        )}
      >
        <h2 className="mb-2 flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wider text-dim">
          <Sparkles className="h-3 w-3" strokeWidth={2.4} />
          Add a policy — in your own words, or drop a document
        </h2>
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitText()}
            disabled={busy}
            placeholder="No agent may email attachments to addresses outside the company domain"
            className="surface no-blur flex-1 rounded-field px-3 py-2 text-body text-paper placeholder:text-dim focus-visible:ring-focus disabled:opacity-60"
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            title="Upload .txt, .md, .pdf or .docx"
            className="surface no-blur flex items-center gap-1.5 rounded-field px-3 py-2 text-body text-muted transition hover:text-paper active:scale-[0.96] focus-visible:ring-focus disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload
          </button>
          <button
            onClick={submitText}
            disabled={busy || !draft.trim()}
            className="rounded-field bg-accent/90 px-3.5 py-2 text-body font-semibold text-ink-950 transition-all duration-150 hover:bg-accent active:scale-[0.96] focus-visible:ring-focus disabled:opacity-50"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) submitFile(f);
            e.target.value = '';
          }}
        />
        <p className="mt-2 text-meta leading-relaxed text-dim">
          A sentence, or a handbook as <code className="font-mono">.txt .md .pdf .docx</code> — a document containing
          several rules becomes several policies. Each is rewritten into the engine&apos;s format, embedded into the
          vector store, and retrievable by the judge on the next tool call. No deploy, no restart.
        </p>

        {report && (
          <div className="mt-3 space-y-1.5">
            <p className="text-meta text-dim">
              <FileText className="mr-1 inline h-3 w-3" />
              {report.source} — {report.created} published
              {report.rejected > 0 && `, ${report.rejected} rejected`}
              {report.truncated && ' · input was truncated to fit the model'}
            </p>

            {report.error && (
              <div className="surface no-blur rounded-field border-l-2 border-l-escalate px-3 py-2">
                <p className="text-body font-semibold text-escalate">Nothing to publish</p>
                <p className="mt-0.5 text-meta leading-snug text-muted">{report.error}</p>
                {report.hint && <p className="mt-1 text-meta leading-snug text-dim">{report.hint}</p>}
              </div>
            )}
            {report.results.map((r, i) =>
              r.ok ? (
                <div key={i} className="surface no-blur rounded-field border-l-2 border-l-allow px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-semibold text-paper">{r.name}</span>
                    {/* A context note is retrievable grounding, not a control.
                        Badging them identically would overstate what was added. */}
                    {r.kind === 'context' ? (
                      <span className="pill border border-accent/40 bg-accent/10 text-accent">context · embedded</span>
                    ) : (
                      <span className="pill border border-allow/40 bg-allow/10 text-allow">live · embedded</span>
                    )}
                    <code className="font-mono text-meta text-dim">{r.id}</code>
                  </div>
                  {/* Show exactly what was written: a control nobody reviewed
                      is not a control. */}
                  <pre className="mt-1.5 overflow-x-auto rounded-field bg-ink-900 px-3 py-2 font-mono text-meta text-muted">
                    {r.markdown}
                  </pre>
                </div>
              ) : (
                <div key={i} className="surface no-blur rounded-field border-l-2 border-l-block px-3 py-2">
                  <p className="text-body font-semibold text-block">Not published</p>
                  <p className="mt-0.5 text-meta leading-snug text-muted">{r.error}</p>
                  {r.markdown && (
                    <pre className="mt-1.5 overflow-x-auto rounded-field bg-ink-900 px-3 py-2 font-mono text-meta text-muted">
                      {r.markdown}
                    </pre>
                  )}
                </div>
              ),
            )}
          </div>
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
