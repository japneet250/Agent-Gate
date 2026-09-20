/**
 * Server-side proxy to the engine's policy list.
 *
 * The engine requires `Authorization: Bearer <AGENTGATE_API_KEY>`. The browser
 * cannot hold that key: every NEXT_PUBLIC_* variable is inlined into the client
 * bundle, so shipping it there would publish the credential to anyone who opens
 * the page — and the engine's key also authorises /evaluate, which spends money.
 *
 * So the key stays server-side, in a variable deliberately NOT prefixed
 * NEXT_PUBLIC_, and the browser talks to this route instead.
 */
import { NextResponse } from 'next/server';

// Never prerender: the policy list is live state, and a build-time snapshot
// would show a stale set of rules on a security console.
export const dynamic = 'force-dynamic';

const ENGINE = process.env.ENGINE_URL ?? process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:8000';
const KEY = process.env.AGENTGATE_API_KEY ?? '';

export async function GET() {
  try {
    const res = await fetch(`${ENGINE}/policies`, {
      headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401) {
      // Say which side is unconfigured. "401" alone sends someone looking at
      // the engine when the missing piece is this app's own environment.
      return NextResponse.json(
        { error: 'engine rejected the dashboard key — set AGENTGATE_API_KEY (no NEXT_PUBLIC_ prefix) for the dashboard process' },
        { status: 401 },
      );
    }
    if (!res.ok) {
      return NextResponse.json({ error: `engine returned ${res.status}` }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: `cannot reach the engine at ${ENGINE}: ${(err as Error).message}` },
      { status: 503 },
    );
  }
}

/**
 * Submit policies, in whatever form the organisation actually has them.
 *
 * Accepts a sentence typed into the console, or an uploaded .txt, .md, .pdf or
 * .docx. The premise of the product is that policies are configuration, not
 * code — so an enterprise must be able to add one without a deploy, and without
 * first retyping their handbook into our markdown shape.
 *
 * A document usually contains SEVERAL rules, so the model returns a list and
 * each one is validated and stored separately. One bad clause in a handbook
 * should not reject the other eleven.
 *
 * Everything the model wrote is shown back before it is relied upon, because a
 * control nobody reviewed is not a control.
 */
import { extractText, isSupported, MAX_FILE_BYTES } from '@/lib/extract';

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';

const SHAPE = `# <Short Title Case Name>
<One or two sentences stating plainly what is prohibited or required, and why.>
Severity: <critical|high|medium|low>
Applies to: <comma-separated from: external_comms, data_access, financial, system_modification, other>`;

/**
 * Context entries exist because an organisation's submission is not always a
 * rule. "We are a healthcare provider in Ontario" governs nothing on its own,
 * but it is exactly the grounding that makes the judge's reasoning correct on
 * the next borderline action. Rejecting it outright threw away the useful half
 * of what people actually paste in.
 *
 * It is stored and embedded like a policy so RAG can retrieve it, and worded so
 * the judge cannot mistake a fact for a prohibition.
 */
const CONTEXT_SHAPE = `# Organisation Context — <Short Topic>
Background for judging actions at this organisation. This is context, not a prohibition, and nothing here blocks an action on its own.
<The facts, in the organisation's own words.>
Severity: info
Applies to: other`;

const SYSTEM = [
  "You convert an organisation's submission into AgentGate markdown.",
  'Return JSON: {"policies": ["<markdown>"], "context": ["<markdown>"], "reason": "<one sentence>"}.',
  'Every array entry is a STRING containing the whole markdown document,',
  'newlines and all. Never an object, never a field map.',
  '',
  '"policies" — one entry per ENFORCEABLE rule, i.e. something an agent must or',
  'must not do. A short imperative counts ("no deleting production data").',
  'Shape:',
  SHAPE,
  '',
  '"context" — one entry per submission that states a FACT about the',
  'organisation rather than a rule: industry, jurisdiction, regulator, customers,',
  'systems of record, size. Shape:',
  CONTEXT_SHAPE,
  '',
  "Keep the organisation's own terms. Never invent limits, numbers, systems or",
  'exceptions the input does not state; keep any numeric threshold exactly. Use',
  'a short noun phrase as the name, and pick "Applies to" only from the listed',
  'categories.',
  '',
  'If the input states a fact about the organisation, you MUST emit a "context"',
  'entry. Never discard it. Return both lists empty ONLY for input carrying',
  'neither a rule nor a fact — a greeting, a single word, a bare title — and then',
  'explain in "reason", addressed to the person who typed it, how to phrase it as',
  'a rule.',
].join('\n');

type Draft = { markdown: string; kind: 'policy' | 'context' };

async function toPolicyMarkdown(text: string): Promise<{ drafts: Draft[]; reason: string }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error('the model returned no policy text');
  let parsed: { policies?: unknown; context?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the model did not return valid JSON');
  }
  const clean = (m: string) => m.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();

  /**
   * Accept the markdown string we asked for, and also the field-map object the
   * model sometimes returns instead under JSON mode. Dropping those objects
   * silently rejected perfectly good policies — the input said "no refunds over
   * 1000 without a manager" and the console said no rule was found.
   */
  const asMarkdown = (entry: unknown): string | null => {
    if (typeof entry === 'string') return clean(entry);
    if (!entry || typeof entry !== 'object') return null;
    const o = entry as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

    // Either { "# Title": "body", Severity, Applies to } or { name/title, ... }.
    const headingKey = Object.keys(o).find((k) => k.startsWith('#'));
    const title = headingKey
      ? headingKey.replace(/^#+\s*/, '')
      : str(o.name) || str(o.title) || str(o.policy);
    const body = headingKey
      ? str(o[headingKey])
      : str(o.body) || str(o.description) || str(o.text) || str(o.rule);
    const severity = str(o.Severity) || str(o.severity) || 'high';
    const appliesRaw = o['Applies to'] ?? o.appliesTo ?? o.applies_to ?? o.categories;
    const applies = Array.isArray(appliesRaw) ? appliesRaw.join(', ') : str(appliesRaw) || 'other';

    if (!title || !body) return null;
    return `# ${title}\n${body}\nSeverity: ${severity}\nApplies to: ${applies}`;
  };

  const take = (v: unknown, kind: Draft['kind']): Draft[] =>
    (Array.isArray(v) ? v : [])
      .map(asMarkdown)
      .filter((m): m is string => Boolean(m && m.trim()))
      .map((markdown) => ({ markdown, kind }));

  return {
    drafts: [...take(parsed.policies, 'policy'), ...take(parsed.context, 'context')],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

type Outcome =
  | { ok: true; id: string; name: string; markdown: string; kind: 'policy' | 'context' }
  | { ok: false; error: string; markdown: string; kind: 'policy' | 'context' };

async function publish(draft: Draft, headers: Record<string, string>): Promise<Outcome> {
  const { markdown, kind } = draft;
  // Validate before storing. A rejected policy must never look accepted on a
  // security console.
  const check = await fetch(`${ENGINE}/policies/validate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ markdown }),
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  const verdict = await check.json().catch(() => ({}));
  if (!check.ok || verdict?.valid === false) {
    return { ok: false, markdown, kind, error: verdict?.error ?? `engine rejected the policy (${check.status})` };
  }

  // Store it. The engine re-reads the corpus and re-embeds, so it is
  // retrievable by the RAG layer on the very next evaluation.
  const created = await fetch(`${ENGINE}/policies`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ markdown }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const result = await created.json().catch(() => ({}));
  if (!created.ok) {
    return { ok: false, markdown, kind, error: result?.detail ?? `engine returned ${created.status}` };
  }
  return { ok: true, id: result.id, name: result.name, markdown, kind };
}

export async function POST(request: Request) {
  let sourceText = '';
  let presetMarkdown: string | null = null;
  let sourceLabel = 'typed';
  let truncated = false;

  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'no file in the upload' }, { status: 400 });
      }
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `${file.name} is ${(file.size / 1e6).toFixed(1)}MB — the limit is ${MAX_FILE_BYTES / 1e6}MB` },
          { status: 413 },
        );
      }
      if (!isSupported(file.name, file.type)) {
        return NextResponse.json(
          { error: `${file.name}: only .txt, .md, .pdf and .docx are supported` },
          { status: 415 },
        );
      }
      const extracted = await extractText({
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
      });
      sourceText = extracted.text;
      truncated = extracted.truncated;
      sourceLabel = `${file.name} (${extracted.kind})`;
    } else {
      const body = await request.json();
      sourceText = String(body?.text ?? '').trim();
      // An operator who already has our format skips the model entirely.
      presetMarkdown = body?.markdown ? String(body.markdown) : null;
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  if (!presetMarkdown && !sourceText) {
    return NextResponse.json({ error: 'send { text }, { markdown }, or a file' }, { status: 400 });
  }

  try {
    let drafts: Draft[];
    let reason = '';
    if (presetMarkdown) {
      drafts = [{ markdown: presetMarkdown, kind: 'policy' }];
    } else {
      if (!OPENAI_KEY) {
        return NextResponse.json(
          { error: 'OPENAI_API_KEY is not set for the dashboard process, so free text cannot be converted' },
          { status: 503 },
        );
      }
      const out = await toPolicyMarkdown(sourceText);
      drafts = out.drafts;
      reason = out.reason;
    }

    if (drafts.length === 0) {
      // Say WHY, in the model's own words. "No enforceable rule found" with no
      // further guidance is a dead end for the person who just typed something.
      return NextResponse.json(
        {
          error: reason || 'that input does not state a rule or any fact about your organisation',
          hint: 'Try a rule — "no refunds over $1,000 without a manager" — or paste a policy document.',
          source: sourceLabel,
        },
        { status: 422 },
      );
    }

    const headers = {
      'content-type': 'application/json',
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
    };

    // Sequential, not parallel: each upsert re-reads and re-embeds the whole
    // corpus, and firing a dozen of those at once would have them racing over
    // the same store.
    const results: Outcome[] = [];
    for (const md of drafts) results.push(await publish(md, headers));

    const created = results.filter((r): r is Extract<Outcome, { ok: true }> => r.ok);
    return NextResponse.json(
      {
        source: sourceLabel,
        truncated,
        created: created.length,
        rejected: results.length - created.length,
        results,
      },
      { status: created.length > 0 ? 201 : 422 },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
