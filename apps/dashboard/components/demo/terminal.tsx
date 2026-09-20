'use client';

import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader2, ShieldCheck, ShieldX, ShieldAlert, Bot } from 'lucide-react';
import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

/**
 * One production agent, in its own terminal.
 *
 * Deliberately a terminal rather than a chat bubble: the audience has to read
 * this as a system doing work, not a chatbot answering. The verdict is the
 * point of the screen, so it is the only thing that gets colour, weight and a
 * rule down its left edge.
 */
type Line =
  | { kind: 'task'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
  | {
      kind: 'verdict';
      tool: string;
      decision: 'allow' | 'block' | 'escalate';
      riskScore: number;
      reasoning: string;
      violatedPolicy: string | null;
      latencyMs: number;
      decidedBy: string;
    }
  | { kind: 'reply'; text: string }
  | { kind: 'error'; text: string };

const DECISION = {
  allow: { label: 'ALLOWED', cls: 'text-allow', border: 'border-l-allow', Icon: ShieldCheck },
  block: { label: 'BLOCKED', cls: 'text-block', border: 'border-l-block', Icon: ShieldX },
  escalate: { label: 'HELD FOR REVIEW', cls: 'text-escalate', border: 'border-l-escalate', Icon: ShieldAlert },
} as const;

const fmtMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms < 10 ? ms.toFixed(2) : Math.round(ms)}ms`;

const fmtArgs = (args: Record<string, unknown>) =>
  Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      // The long body is what carries the SSN. Truncated on screen so the
      // verdict stays visible — never truncated before the gateway sees it.
      return `${k}: ${s.length > 70 ? s.slice(0, 70) + '…' : s}`;
    })
    .join('  ');

export function AgentTerminal({ persona, onActivity }: { persona: Persona; onActivity?: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const sessionId = useRef(`${persona.id}-${Date.now()}`);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [lines]);

  const run = async (task: string) => {
    if (busy || !task.trim()) return;
    setBusy(true);
    setLines((l) => [...l, { kind: 'task', text: task }]);
    setInput('');
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: persona.id, task, sessionId: sessionId.current }),
      });
      if (!res.body) throw new Error('no stream from /api/agent');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          if (!p.trim()) continue;
          const ev = JSON.parse(p);
          if (ev.type === 'done') continue;
          if (ev.type === 'verdict') onActivity?.();
          setLines((l) => [...l, { ...ev, kind: ev.type } as Line]);
        }
      }
    } catch (err) {
      setLines((l) => [...l, { kind: 'error', text: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex h-[36rem] flex-col overflow-hidden rounded-card border border-white/10 bg-ink-850"
      style={{ boxShadow: `0 0 0 1px ${persona.glow}, 0 24px 64px -32px rgba(0,0,0,0.95)` }}
    >
      {/* macOS window chrome: sells "a real machine" in one glance. */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-ink-800 px-3 py-2">
        <span className="flex gap-1.5">
          <i className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <i className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="ml-1 grid h-5 w-5 place-items-center rounded-field" style={{ background: persona.glow }}>
          <Bot className="h-3 w-3" style={{ color: persona.accent }} strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-meta font-semibold leading-tight text-paper">{persona.company}</p>
          <p className="truncate text-meta leading-tight text-dim">{persona.sector}</p>
        </div>
        <span
          className="shrink-0 rounded-pill px-1.5 py-0.5 text-meta"
          style={{ background: persona.glow, color: persona.accent }}
        >
          {persona.role}
        </span>
      </div>

      <div ref={scroller} className="flex-1 space-y-2.5 overflow-y-auto p-4 font-mono text-body leading-relaxed">
        {lines.length === 0 && (
          <div className="space-y-1.5">
            <p className="text-dim">Try one, or type your own:</p>
            {persona.prompts.map((p) => (
              <button
                key={p}
                onClick={() => void run(p)}
                disabled={busy}
                className="block w-full truncate rounded-field border border-white/10 px-2.5 py-2 text-left text-muted transition hover:border-white/25 hover:text-paper disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {lines.map((l, i) => {
          if (l.kind === 'task')
            return (
              <p key={i} className="break-words text-paper">
                <span style={{ color: persona.accent }}>❯ </span>
                {l.text}
              </p>
            );
          if (l.kind === 'status')
            return (
              <p key={i} className="text-dim">
                · {l.text}
              </p>
            );
          if (l.kind === 'call')
            return (
              <p key={i} className="break-words text-muted">
                <span className="text-dim">→ calling </span>
                <span className="text-paper">{l.tool}</span>
                <span className="text-dim"> ({fmtArgs(l.args)})</span>
              </p>
            );
          if (l.kind === 'error')
            return (
              <p key={i} className="break-words text-block">
                ✘ {l.text}
              </p>
            );
          if (l.kind === 'reply')
            return (
              <p key={i} className="border-t border-white/10 pt-2 text-muted">
                {l.text}
              </p>
            );

          const d = DECISION[l.decision];
          return (
            <div
              key={i}
              className={cn('animate-slide-in rounded-field border-l-2 bg-ink-800 px-3 py-2.5', d.border)}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <d.Icon className={cn('h-4 w-4', d.cls)} strokeWidth={2.4} />
                <span className={cn('text-[0.9rem] font-semibold tracking-wide', d.cls)}>{d.label}</span>
                <span className="font-semibold text-paper">risk {l.riskScore}/100</span>
                <span className="text-dim">· {fmtMs(l.latencyMs)}</span>
                {/* The rule-vs-judge split is the cost story: most calls never
                    reach a model at all. */}
                <span className="rounded-pill border border-white/10 px-1.5 text-meta text-dim">
                  {l.decidedBy === 'rules' ? 'rule engine · no model' : 'LLM judge · RAG'}
                </span>
              </div>
              <p className="mt-1 leading-snug text-muted">{l.reasoning}</p>
              {l.violatedPolicy && <p className="mt-0.5 text-meta text-dim">policy: {l.violatedPolicy}</p>}
            </div>
          );
        })}

        {busy && (
          <p className="flex items-center gap-1.5 text-dim">
            <Loader2 className="h-3 w-3 animate-spin" />
            working…
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-white/10 bg-ink-800 px-3 py-2.5">
        <span style={{ color: persona.accent }} className="font-mono text-body">
          ❯
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run(input)}
          disabled={busy}
          placeholder="ask this agent to do something…"
          className="flex-1 bg-transparent font-mono text-body text-paper outline-none placeholder:text-dim disabled:opacity-50"
        />
        <button
          onClick={() => void run(input)}
          disabled={busy || !input.trim()}
          className="rounded-field px-1.5 py-1 text-dim transition hover:text-paper disabled:opacity-40"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
