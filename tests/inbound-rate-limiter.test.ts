import { resolveClientAddress, UNKNOWN_CLIENT_ADDRESS } from '../src/http/client-address.ts';
import {
  createInboundRateLimiter,
  type InboundRateLimiter,
} from '../src/http/inbound-rate-limiter.ts';

Deno.test('client address trusts only the rightmost ACA forwarding value', () => {
  assertEquals(
    resolveClientAddress('198.51.100.9, 203.0.113.7', '192.0.2.20'),
    '203.0.113.7',
  );
  assertEquals(resolveClientAddress(null, '192.0.2.20'), '192.0.2.20');
  assertEquals(
    resolveClientAddress('attacker.example, invalid', '192.0.2.20'),
    UNKNOWN_CLIENT_ADDRESS,
  );
});

Deno.test('client address validates IPv4 and canonicalizes equivalent IPv6 spellings', () => {
  assertEquals(resolveClientAddress('256.1.1.1'), UNKNOWN_CLIENT_ADDRESS);
  assertEquals(resolveClientAddress('01.2.3.4'), UNKNOWN_CLIENT_ADDRESS);
  assertEquals(resolveClientAddress('[2001:db8::1]'), UNKNOWN_CLIENT_ADDRESS);
  assertEquals(resolveClientAddress('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assertEquals(resolveClientAddress('2001:db8::1'), '2001:db8::1');
});

Deno.test('rate limiter enforces an inclusive fixed quota and exact rollover', () => {
  const limiter = configuredLimiter({ requestsPerWindow: 2, windowMs: 1_000 });

  assertAllowed(limiter.acquire('203.0.113.7', 100), 1);
  assertAllowed(limiter.acquire('203.0.113.7', 999), 0);
  assertDenied(limiter.acquire('203.0.113.7', 1_099), 1);
  assertAllowed(limiter.acquire('203.0.113.7', 1_100), 1);
});

Deno.test('rate limiter bounds tracked clients and shares one overflow quota', () => {
  const limiter = configuredLimiter({
    requestsPerWindow: 1,
    windowMs: 1_000,
    maxClientPartitions: 1,
  });

  assertAllowed(limiter.acquire('203.0.113.1', 0), 0);
  assertAllowed(limiter.acquire('203.0.113.2', 0), 0);
  assertDenied(limiter.acquire('203.0.113.3', 0), 1);
  assertEquals(limiter.stats().clientPartitions, 1);
  assertEquals(limiter.stats().overflowRequests, 2);

  assertAllowed(limiter.acquire('203.0.113.2', 1_000), 0);
  assertEquals(limiter.stats().clientPartitions, 1);
});

function configuredLimiter(
  overrides: Readonly<{
    requestsPerWindow?: number;
    windowMs?: number;
    maxClientPartitions?: number;
  }> = {},
): InboundRateLimiter {
  const result = createInboundRateLimiter({
    requestsPerWindow: overrides.requestsPerWindow ?? 10,
    windowMs: overrides.windowMs ?? 60_000,
    maxClientPartitions: overrides.maxClientPartitions ?? 100,
  });
  if (!result.ok) {
    throw new Error(`Unexpected limiter configuration error: ${result.error.code}`);
  }
  return result.limiter;
}

function assertAllowed(
  result: ReturnType<InboundRateLimiter['acquire']>,
  remaining: number,
): asserts result is Extract<typeof result, { allowed: true }> {
  if (!result.allowed) {
    throw new Error(
      `Expected an allowed decision, received retry-after ${result.retryAfterSeconds}`,
    );
  }
  assertEquals(result.remaining, remaining);
}

function assertDenied(
  result: ReturnType<InboundRateLimiter['acquire']>,
  retryAfterSeconds: number,
): asserts result is Extract<typeof result, { allowed: false }> {
  if (result.allowed) {
    throw new Error(`Expected a denied decision, received ${result.remaining} remaining`);
  }
  assertEquals(result.retryAfterSeconds, retryAfterSeconds);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
