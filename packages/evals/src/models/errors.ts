/**
 * Failure buckets for an LLM judge.
 *
 * A judge can fail in ways that say nothing about the model's judgement, and
 * scoring those as wrong decisions makes a provider look worse than it is.
 * These two are tracked separately from decisions:
 *
 *   invalid  — the provider returned something that does not conform to the
 *              requested schema. That is a plumbing failure: OpenAI's strict
 *              json_schema and Gemini's responseSchema accept different
 *              JSON-Schema subsets, so a schema one accepts the other may not.
 *   skipped  — the request never resolved (rate limited, timed out) after the
 *              retry budget was exhausted. Gemini's free-tier RPM caps make
 *              this common and it is not a quality signal.
 */
export class JudgeInvalidOutput extends Error {
  readonly raw: string | undefined;
  constructor(message: string, raw?: string) {
    super(message);
    this.name = 'JudgeInvalidOutput';
    this.raw = raw;
  }
}

export class JudgeUnavailable extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = 'JudgeUnavailable';
    this.attempts = attempts;
  }
}

type MaybeHttpError = {
  status?: number;
  statusCode?: number;
  code?: string | number;
  message?: string;
  headers?: Record<string, string> | { get?: (k: string) => string | null };
};

export function httpStatusOf(err: unknown): number | undefined {
  const e = err as MaybeHttpError;
  const raw = e?.status ?? e?.statusCode;
  return typeof raw === 'number' ? raw : undefined;
}

/** Rate limits, transient server errors and network timeouts are worth retrying. */
export function isRetryable(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  const e = err as MaybeHttpError;
  const code = String(e?.code ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return true;
  }
  const message = String(e?.message ?? '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('rate limit') ||
    message.includes('overloaded') ||
    message.includes('unavailable')
  );
}

/** Honour Retry-After when the provider sends one; it knows better than we do. */
export function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as MaybeHttpError)?.headers;
  if (!headers) return undefined;
  const get =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (k: string) => (headers as { get: (k: string) => string | null }).get(k)
      : (k: string) => (headers as Record<string, string>)[k];
  const raw = get('retry-after') ?? get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
};

export const DEFAULT_RETRY: RetryOptions = {
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded exponential backoff with jitter. Exhausting the budget raises
 * JudgeUnavailable so the caller can bucket it as skipped rather than wrong.
 */
export async function withRetry<T>(fn: () => Promise<T>, options = DEFAULT_RETRY): Promise<T> {
  let lastErr: unknown;

  let used = 0;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      used = attempt;
      if (!isRetryable(err) || attempt === options.attempts) break;

      const backoff = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      // Jitter so a whole suite doesn't retry in lockstep and re-trip the limit.
      const jittered = Math.round(backoff * (0.5 + Math.random() * 0.5));
      const delay = retryAfterMs(err) ?? jittered;
      options.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }

  const status = httpStatusOf(lastErr);
  // Report attempts actually made, not the budget. A non-retryable error breaks
  // out after one try, and saying "gave up after 4 attempts" for a 404 sends
  // whoever reads it hunting for a rate limit that was never there.
  throw new JudgeUnavailable(
    `gave up after ${used} attempt(s)${status ? ` (last status ${status})` : ''}: ${
      (lastErr as Error)?.message ?? 'unknown error'
    }`,
    used,
  );
}
