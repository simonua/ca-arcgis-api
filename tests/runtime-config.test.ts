import { parseRuntimeConfiguration } from '../src/config/runtime-config.ts';

Deno.test('runtime configuration uses fixture-safe operational defaults', () => {
  const result = parseRuntimeConfiguration({});

  assert(result.ok, result.ok ? '' : result.error.variable);
  assertEquals(result.value.httpPort, 8080);
  assertEquals(result.value.pollEnabled, false);
  assertEquals(result.value.pollIntervalMs, 300_000);
  assertEquals(result.value.pollTimeoutMs, 10_000);
  assertEquals(result.value.maxBackoffMs, 1_800_000);
  assert(Object.isFrozen(result.value));
});

Deno.test('runtime configuration accepts reviewed boundary values', () => {
  const result = parseRuntimeConfiguration({
    HTTP_PORT: '1024',
    POLL_ENABLED: 'true',
    POLL_INTERVAL_SECONDS: '600',
    POLL_TIMEOUT_SECONDS: '30',
    MAX_BACKOFF_SECONDS: '600',
  });

  assert(result.ok, result.ok ? '' : result.error.variable);
  assertEquals(result.value.httpPort, 1024);
  assertEquals(result.value.pollEnabled, true);
  assertEquals(result.value.pollIntervalMs, 600_000);
  assertEquals(result.value.pollTimeoutMs, 30_000);
  assertEquals(result.value.maxBackoffMs, 600_000);
});

Deno.test('runtime configuration rejects malformed booleans and integers', () => {
  assertFailure({ POLL_ENABLED: 'TRUE' }, 'POLL_ENABLED', 'invalid-boolean');
  assertFailure({ HTTP_PORT: ' 8080' }, 'HTTP_PORT', 'invalid-integer');
  assertFailure({ POLL_INTERVAL_SECONDS: '3e2' }, 'POLL_INTERVAL_SECONDS', 'invalid-integer');
  assertFailure({ POLL_TIMEOUT_SECONDS: '10.5' }, 'POLL_TIMEOUT_SECONDS', 'invalid-integer');
  assertFailure(
    { MAX_BACKOFF_SECONDS: '9007199254740992' },
    'MAX_BACKOFF_SECONDS',
    'invalid-integer',
  );
});

Deno.test('runtime configuration rejects values outside reviewed ranges', () => {
  assertFailure({ HTTP_PORT: '1023' }, 'HTTP_PORT', 'out-of-range');
  assertFailure({ HTTP_PORT: '65536' }, 'HTTP_PORT', 'out-of-range');
  assertFailure({ POLL_INTERVAL_SECONDS: '299' }, 'POLL_INTERVAL_SECONDS', 'out-of-range');
  assertFailure({ POLL_TIMEOUT_SECONDS: '1' }, 'POLL_TIMEOUT_SECONDS', 'out-of-range');
  assertFailure({ POLL_TIMEOUT_SECONDS: '31' }, 'POLL_TIMEOUT_SECONDS', 'out-of-range');
});

Deno.test('runtime configuration requires maximum backoff at least the poll interval', () => {
  assertFailure(
    { POLL_INTERVAL_SECONDS: '1801' },
    'MAX_BACKOFF_SECONDS',
    'below-poll-interval',
  );
});

function assertFailure(
  environment: Readonly<Record<string, string>>,
  variable: string,
  reason: string,
): void {
  const result = parseRuntimeConfiguration(environment);
  assert(!result.ok, 'Expected configuration to fail');
  assertEquals(result.error.variable, variable);
  assertEquals(result.error.reason, reason);
}

function assert(condition: boolean, message = 'Assertion failed'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
