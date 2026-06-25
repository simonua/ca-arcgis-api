import {
  createMonotonicPermitGate,
  MIN_COLLECTION_INTERVAL_MS,
} from '../src/harvesting/monotonic-permit-gate.ts';

Deno.test('rejects collection intervals below the hard five-minute floor', () => {
  const result = createMonotonicPermitGate(MIN_COLLECTION_INTERVAL_MS - 1);

  assert(!result.ok);
  assertEquals(result.error.code, 'interval-below-minimum');
});

Deno.test('grants one permit without accumulating burst capacity', () => {
  const gate = createGate();

  const first = gate.acquire(1_000);
  assert(first.granted);
  assertEquals(first.nextAllowedAtMonotonicMs, 301_000);

  const early = gate.acquire(300_999);
  assert(!early.granted);
  assertEquals(early.reason, 'permit-unavailable');
  assertEquals(early.nextAllowedAtMonotonicMs, 301_000);

  const boundary = gate.acquire(301_000);
  assert(boundary.granted);
  assertEquals(boundary.nextAllowedAtMonotonicMs, 601_000);

  const delayedGate = createGate();
  assert(delayedGate.acquire(0).granted);
  assert(delayedGate.acquire(900_000).granted);
  const immediateAfterDelay = delayedGate.acquire(900_000);
  assert(!immediateAfterDelay.granted);
  assertEquals(immediateAfterDelay.reason, 'permit-unavailable');
  assertEquals(immediateAfterDelay.nextAllowedAtMonotonicMs, 1_200_000);
});

Deno.test('fails closed when monotonic time is invalid or moves behind the deadline', () => {
  const gate = createGate();

  const invalid = gate.acquire(Number.NaN);
  assert(!invalid.granted);
  assertEquals(invalid.reason, 'invalid-time');

  const first = gate.acquire(500_000);
  assert(first.granted);

  const movedBack = gate.acquire(100_000);
  assert(!movedBack.granted);
  assertEquals(movedBack.reason, 'permit-unavailable');
  assertEquals(movedBack.nextAllowedAtMonotonicMs, 800_000);
});

function createGate() {
  const result = createMonotonicPermitGate(MIN_COLLECTION_INTERVAL_MS);
  if (!result.ok) {
    throw new Error(`Unexpected permit configuration error: ${result.error.code}`);
  }
  return result.gate;
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
