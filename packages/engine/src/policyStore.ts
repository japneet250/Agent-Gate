import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import type { ActionCategory } from '@agentgate/shared';
import { config, hasOpenAI } from './config.ts';
import type { RetrievedPolicy } from './state.ts';

const POLICY_DIR = join(dirname(fileURLToPath(import.meta.url)), 'policies');

interface StoredPolicy extends Omit<RetrievedPolicy, 'score'> {
  embedding?: number[];
  tokens: Set<string>;
}

let store: StoredPolicy[] | null = null;
let embeddedOnce = false;

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'are', 'be', 'may',
  'not', 'that', 'this', 'with', 'as', 'by', 'from', 'it', 'its', 'any', 'all', 'must',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Parse `# Title`, body, `Severity:` and `Applies to:` out of a policy markdown file. */
function parsePolicy(file: string, raw: string): StoredPolicy {
  const id = file.replace(/\.md$/, '');
  const name = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;
  const severity = raw.match(/^Severity:\s*(.+)$/im)?.[1]?.trim().toLowerCase() ?? 'medium';
  const appliesTo = (raw.match(/^Applies to:\s*(.+)$/im)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ActionCategory[];
  const description = raw
    .replace(/^#.+$/m, '')
    .replace(/^Severity:.+$/im, '')
    .replace(/^Applies to:.+$/im, '')
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
    tokens: tokenize(`${name} ${description}`),
  };
}

export function loadPolicies(): StoredPolicy[] {
  if (store) return store;
  store = readdirSync(POLICY_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parsePolicy(f, readFileSync(join(POLICY_DIR, f), 'utf8')));
  return store;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

let openai: OpenAI | null = null;
function client(): OpenAI {
  openai ??= new OpenAI({ apiKey: config.openaiApiKey });
  return openai;
}

async function embed(texts: string[]): Promise<number[][]> {
  const res = await client().embeddings.create({ model: config.embedModel, input: texts });
  return res.data.map((d) => d.embedding);
}

/**
 * Embed every policy once, at startup. Cheap (18 short docs) and keeps the hot
 * path to a single query embedding. Safe to call repeatedly.
 */
export async function warmPolicyIndex(): Promise<void> {
  const policies = loadPolicies();
  if (embeddedOnce || !hasOpenAI()) return;
  try {
    const vectors = await embed(policies.map((p) => p.text));
    policies.forEach((p, i) => {
      p.embedding = vectors[i];
    });
    embeddedOnce = true;
  } catch (err) {
    // Keyword-only retrieval still works; don't take the pipeline down for it.
    console.warn('[agentgate] policy embedding failed, falling back to keyword search:', err);
  }
}

/** Keyword overlap score in [0,1] — our stand-in for BM25 in the hybrid blend. */
function keywordScore(queryTokens: Set<string>, policy: StoredPolicy): number {
  if (queryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (policy.tokens.has(t)) hits++;
  return hits / queryTokens.size;
}

export interface RetrieveOptions {
  category?: ActionCategory;
  topK?: number;
}

/**
 * Hybrid retrieval: dense vector similarity + keyword overlap + a small boost
 * for policies tagged with the classified action category.
 */
export async function retrievePolicies(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedPolicy[]> {
  const policies = loadPolicies().filter((p) => p.enabled);
  const topK = opts.topK ?? config.topK;
  const queryTokens = tokenize(query);

  let queryVector: number[] | null = null;
  if (hasOpenAI()) {
    await warmPolicyIndex();
    try {
      [queryVector] = await embed([query]);
    } catch (err) {
      console.warn('[agentgate] query embedding failed, keyword-only retrieval:', err);
    }
  }

  const scored = policies.map((p) => {
    const dense = queryVector && p.embedding ? cosine(queryVector, p.embedding) : 0;
    const sparse = keywordScore(queryTokens, p);
    const categoryBoost = opts.category && p.appliesTo.includes(opts.category) ? 0.15 : 0;
    const score = queryVector && p.embedding
      ? 0.7 * dense + 0.3 * sparse + categoryBoost
      : sparse + categoryBoost;
    const { embedding, tokens, ...rest } = p;
    return { ...rest, score } satisfies RetrievedPolicy;
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
