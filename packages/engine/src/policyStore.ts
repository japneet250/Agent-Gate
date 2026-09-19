import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionCategory } from '@agentgate/shared';
import { config, hasOpenAI } from './config.ts';
import { guardedCall, openai, usageOf, type Usage } from './llm.ts';
import { vectorStore } from './store/index.ts';
import type { RetrievedPolicy } from './state.ts';
import { noopTrace, type Trace } from './trace.ts';

const POLICY_DIR = join(dirname(fileURLToPath(import.meta.url)), 'policies');

export interface StoredPolicy extends Omit<RetrievedPolicy, 'score' | 'denseScore' | 'sparseScore'> {
  tokens: Set<string>;
}

let store: StoredPolicy[] | null = null;
let indexed = false;

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'are', 'be', 'may',
  'not', 'that', 'this', 'with', 'as', 'by', 'from', 'it', 'its', 'any', 'all', 'must',
  'agent', 'agents', 'action', 'called', 'arguments', 'tool', 'category',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Parse `# Title`, body, `Severity:` and `Applies to:` out of a policy file. */
function parsePolicy(file: string, raw: string): StoredPolicy {
  const id = file.replace(/\.md$/, '');
  const name = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;
  const severity = raw.match(/^Severity:\s*(.+)$/im)?.[1]?.trim().toLowerCase() ?? 'medium';
  const enforcedBy =
    /^Enforced by:\s*pattern_detector\s*$/im.test(raw) ? 'pattern_detector' : 'judge';
  const appliesTo = (raw.match(/^Applies to:\s*(.+)$/im)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ActionCategory[];
  const description = raw
    .replace(/^#.+$/m, '')
    .replace(/^Severity:.+$/im, '')
    .replace(/^Applies to:.+$/im, '')
    .replace(/^Enforced by:.+$/im, '')
    .trim();

  return {
    id,
    name,
    description,
    type: 'llm',
    enabled: true,
    text: raw.trim(),
    severity,
    appliesTo,
    enforcedBy,
    tokens: tokenize(`${name} ${description}`),
  };
}

export function loadPolicies(): StoredPolicy[] {
  store ??= readdirSync(POLICY_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parsePolicy(f, readFileSync(join(POLICY_DIR, f), 'utf8')));
  return store;
}

/** Test seam: replace the policy set without touching disk. */
export function setPolicies(raw: { file: string; content: string }[] | null): void {
  store = raw ? raw.map((r) => parsePolicy(r.file, r.content)) : null;
  indexed = false;
}

async function embed(texts: string[], trace: Trace, label: string): Promise<{ vectors: number[][]; usage: Usage }> {
  const gen = trace.generation(label, config.embedModel, { count: texts.length });
  const res = await guardedCall(
    () => openai().embeddings.create({ model: config.embedModel, input: texts }),
    { label: 'embeddings', timeoutMs: config.embedTimeoutMs },
  );
  const usage = usageOf(config.embedModel, res.usage as { prompt_tokens?: number });
  gen.end({ dimensions: res.data[0]?.embedding.length }, usage);
  return { vectors: res.data.map((d) => d.embedding), usage };
}

/**
 * Embed every policy once, into the configured vector store. Cheap (18 short
 * docs) and it keeps the hot path down to a single query embedding.
 */
export async function warmPolicyIndex(trace: Trace = noopTrace): Promise<boolean> {
  const policies = loadPolicies();
  if (indexed || !hasOpenAI()) return indexed;
  try {
    const { vectors } = await embed(policies.map((p) => p.text), trace, 'policy_index.embed');
    await vectorStore().upsert(
      policies.map((p, i) => ({ id: p.id, vector: vectors[i], metadata: { name: p.name } })),
    );
    indexed = true;
  } catch (err) {
    // Keyword-only retrieval still works; don't take the pipeline down for this.
    console.warn('[agentgate] policy embedding failed, keyword-only retrieval:', (err as Error).message);
  }
  return indexed;
}

export const isIndexed = () => indexed;

/** Keyword overlap in [0,1] — our stand-in for BM25 in the hybrid blend. */
function keywordScore(queryTokens: Set<string>, policy: StoredPolicy): number {
  if (queryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (policy.tokens.has(t)) hits++;
  return hits / queryTokens.size;
}

export interface RetrieveOptions {
  category?: ActionCategory;
  topK?: number;
  trace?: Trace;
}

/**
 * Hybrid retrieval: dense vector similarity + keyword overlap + a small boost
 * for policies tagged with the classified action category. Degrades to
 * keyword-only when embeddings are unavailable.
 */
export async function retrievePolicies(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedPolicy[]> {
  const trace = opts.trace ?? noopTrace;
  const policies = loadPolicies().filter((p) => p.enabled);
  const topK = opts.topK ?? config.topK;
  const queryTokens = tokenize(query);

  const dense = new Map<string, number>();
  if (hasOpenAI()) {
    await warmPolicyIndex(trace);
    if (indexed) {
      try {
        const { vectors } = await embed([query], trace, 'policy_retriever.embed_query');
        // Score every policy, not just top-K, so the sparse signal can still promote one.
        for (const m of await vectorStore().query(vectors[0], policies.length)) {
          dense.set(m.id, m.score);
        }
      } catch (err) {
        console.warn('[agentgate] query embedding failed, keyword-only:', (err as Error).message);
      }
    }
  }

  const useDense = dense.size > 0;
  const scored: RetrievedPolicy[] = policies.map((p) => {
    const denseScore = dense.get(p.id) ?? 0;
    const sparseScore = keywordScore(queryTokens, p);
    const boost = opts.category && p.appliesTo.includes(opts.category) ? config.categoryBoost : 0;
    const score = useDense
      ? config.denseWeight * denseScore + config.sparseWeight * sparseScore + boost
      : sparseScore + boost;
    const { tokens, ...rest } = p;
    return { ...rest, score, denseScore, sparseScore };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** Guardrail helper: the judge may only cite policies that actually exist. */
export function policyExists(nameOrId: string): boolean {
  const needle = nameOrId.trim().toLowerCase();
  return loadPolicies().some(
    (p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle,
  );
}
