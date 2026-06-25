export interface InboundRateLimitOptions {
  readonly requestsPerWindow: number;
  readonly windowMs: number;
  readonly maxClientPartitions: number;
}

export type InboundRateLimitDecision =
  | Readonly<{ allowed: true; remaining: number }>
  | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export interface InboundRateLimiter {
  acquire(clientKey: string, nowMonotonicMs: number): InboundRateLimitDecision;
  stats(): Readonly<{ clientPartitions: number; overflowRequests: number }>;
}

export type InboundRateLimiterCreationResult =
  | Readonly<{ ok: true; limiter: InboundRateLimiter }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code: 'invalid-max-partitions' | 'invalid-request-limit' | 'invalid-window';
    }>;
  }>;

interface WindowCounter {
  startedAt: number;
  used: number;
}

/** Limits tracked clients independently while bounding unknown clients in one overflow window. */
export function createInboundRateLimiter(
  options: InboundRateLimitOptions,
): InboundRateLimiterCreationResult {
  if (!isPositiveSafeInteger(options.requestsPerWindow)) {
    return failure('invalid-request-limit');
  }
  if (!isPositiveSafeInteger(options.windowMs)) {
    return failure('invalid-window');
  }
  if (!isPositiveSafeInteger(options.maxClientPartitions)) {
    return failure('invalid-max-partitions');
  }

  const clients = new Map<string, WindowCounter>();
  const overflow: WindowCounter = { startedAt: 0, used: 0 };
  let overflowRequests = 0;

  return Object.freeze({
    ok: true,
    limiter: Object.freeze({
      acquire(clientKey: string, nowMonotonicMs: number): InboundRateLimitDecision {
        if (!isMonotonicTime(nowMonotonicMs)) {
          return Object.freeze({ allowed: false, retryAfterSeconds: 1 });
        }
        removeExpiredClients(nowMonotonicMs);

        const normalizedKey = validClientKey(clientKey) ? clientKey : 'unknown';
        let counter = clients.get(normalizedKey);
        if (counter === undefined && clients.size < options.maxClientPartitions) {
          counter = { startedAt: nowMonotonicMs, used: 0 };
          clients.set(normalizedKey, counter);
        }
        if (counter === undefined) {
          counter = overflow;
          overflowRequests += 1;
        }
        return consume(counter, nowMonotonicMs);
      },

      stats(): Readonly<{ clientPartitions: number; overflowRequests: number }> {
        return Object.freeze({ clientPartitions: clients.size, overflowRequests });
      },
    }),
  });

  function removeExpiredClients(nowMonotonicMs: number): void {
    for (const [key, counter] of clients) {
      if (nowMonotonicMs - counter.startedAt >= options.windowMs) {
        clients.delete(key);
      }
    }
  }

  function consume(counter: WindowCounter, nowMonotonicMs: number): InboundRateLimitDecision {
    if (
      nowMonotonicMs < counter.startedAt || nowMonotonicMs - counter.startedAt >= options.windowMs
    ) {
      counter.startedAt = nowMonotonicMs;
      counter.used = 0;
    }
    if (counter.used >= options.requestsPerWindow) {
      const remainingMs = Math.max(1, options.windowMs - (nowMonotonicMs - counter.startedAt));
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
      });
    }
    counter.used += 1;
    return Object.freeze({
      allowed: true,
      remaining: options.requestsPerWindow - counter.used,
    });
  }
}

function validClientKey(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function isMonotonicTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function failure(
  code: 'invalid-max-partitions' | 'invalid-request-limit' | 'invalid-window',
): InboundRateLimiterCreationResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}
