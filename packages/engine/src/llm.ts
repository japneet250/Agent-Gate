import OpenAI from 'openai';
import { config } from './config.ts';

let client: OpenAI | null = null;

export function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 0 });
  return client;
}

/** Test seam: swap in a stub client so the pipeline can be tested without a key. */
export function setOpenAIClient(next: OpenAI | null): void {
  client = next;
}

export class LlmError extends Error {}

/** Reject a hung call so the latency-budget guardrail can fire. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new LlmError(`${label} exceeded ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Circuit breaker. After `failureThreshold` consecutive failures we stop calling
 * the model for `cooldownMs` and let callers fall back immediately, rather than
 * paying the timeout on every action while the provider is down.
 */
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    readonly name: string,
    private readonly failureThreshold = config.circuitBreakerThreshold,
    private readonly cooldownMs = config.circuitBreakerCooldownMs,
  ) {}

  get isOpen(): boolean {
    if (this.failures < this.failureThreshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.failureThreshold) this.openedAt = Date.now();
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
  }
}

const breakers = new Map<string, CircuitBreaker>();
function breaker(name: string): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CircuitBreaker(name);
    breakers.set(name, b);
  }
  return b;
}

export function resetBreakers(): void {
  for (const b of breakers.values()) b.reset();
}

const isRetryable = (err: unknown): boolean => {
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 408 || (typeof status === 'number' && status >= 500);
};

export interface CallOptions {
  label: string;
  timeoutMs: number;
  retries?: number;
}

/**
 * One LLM call with timeout, one retry on transient errors, and circuit
 * breaking. Throws `LlmError` when it gives up — callers degrade, never crash.
 */
export async function guardedCall<T>(fn: () => Promise<T>, opts: CallOptions): Promise<T> {
  const b = breaker(opts.label);
  if (b.isOpen) {
    throw new LlmError(`${opts.label} circuit open — provider failing, skipping call`);
  }

  const attempts = (opts.retries ?? config.retries) + 1;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      const out = await withTimeout(fn(), opts.timeoutMs, opts.label);
      b.recordSuccess();
      return out;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isRetryable(err)) {
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        continue;
      }
      break;
    }
  }

  b.recordFailure();
  throw new LlmError(`${opts.label} failed: ${(lastErr as Error)?.message ?? lastErr}`);
}

/** Per-1M-token prices, used for the cost figure on each LangFuse generation. */
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'text-embedding-3-small': { in: 0.02, out: 0 },
};

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export function usageOf(model: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): Usage {
  const price = PRICING[model] ?? { in: 0, out: 0 };
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    costUsd: (promptTokens * price.in + completionTokens * price.out) / 1_000_000,
  };
}
