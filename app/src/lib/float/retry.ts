/**
 * A gate and a backoff for reads against the public RPC.
 *
 * This node rate-limits, and what it returns is a bare `{"code":429,"message":
 * "Too Many Requests"}` that viem surfaces as "An unknown RPC error occurred."
 * That message is why the throttling went unnamed for so long: it reads like a
 * transport fault rather than a quota, so the obvious response is to retry
 * harder, which is exactly wrong.
 *
 * Every fanned out read in this app has a per-item `.catch()`, so a 429 does
 * not raise, it DELETES A ROW. The result is a short answer that looks
 * complete: `lpPools()` returned 6, 8 and 2 pools on three consecutive calls,
 * `cfAllTokensDetailed()` lost the token the page was open on, and this
 * module's own chart lost four of its five trades between two refreshes. None
 * of it logged anything.
 *
 * Two mechanisms, and the order matters:
 *
 *  1. A CONCURRENCY GATE. Retrying a 429 without capping concurrency makes the
 *     quota problem worse, because the retries land on top of the burst that
 *     caused it. Capping first is what actually reduces the error rate.
 *  2. Backoff on top, which handles the residual.
 *
 * A rate-limited call is also reported as rate-limited rather than as an
 * unknown error, so a caller can decline to do something expensive (like
 * splitting one wide `getLogs` into hundreds of narrow ones) that would only
 * deepen the hole.
 */

const ATTEMPTS = 4;
const BASE_DELAY_MS = 400;
/** Concurrent RPC calls allowed through this module at once. */
const MAX_IN_FLIGHT = 4;

let inFlight = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((release) => waiting.push(() => {
    inFlight += 1;
    release();
  }));
}

function release() {
  inFlight -= 1;
  const next = waiting.shift();
  if (next) next();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when the node refused for quota reasons rather than failing. */
export function isRateLimited(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message}` : String(e);
  return /429|too many requests|rate limit/i.test(text);
}

export class RpcError extends Error {
  readonly rateLimited: boolean;
  constructor(message: string, rateLimited: boolean) {
    super(message);
    this.name = "RpcError";
    this.rateLimited = rateLimited;
  }
}

export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    await acquire();
    try {
      return await fn();
    } catch (e) {
      last = e;
    } finally {
      release();
    }
    if (attempt < ATTEMPTS - 1) {
      // Exponential, with jitter so a fanned out batch does not retry in step
      // and reproduce the burst that lost the first attempt.
      await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * 250);
    }
  }
  const detail = last instanceof Error ? last.message.split("\n")[0] : String(last);
  const limited = isRateLimited(last);
  throw new RpcError(
    `${label} failed after ${ATTEMPTS} attempts: ${limited ? "rate limited by the RPC" : detail}`,
    limited,
  );
}

/** Run tasks with the same concurrency cap the retries respect. */
export async function mapLimited<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_IN_FLIGHT, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
