import { createOperatingWindowGate } from '../src/harvesting/operating-window-gate.ts';

const FIRST_START = Date.parse('2026-06-25T12:00:00.000Z');
const FIRST_END = Date.parse('2026-06-25T22:00:00.000Z');
const SECOND_START = Date.parse('2026-06-26T12:00:00.000Z');
const SECOND_END = Date.parse('2026-06-26T22:00:00.000Z');

Deno.test('allows inclusive starts and rejects exclusive operating-window closes', () => {
  const gate = createGate();

  const atStart = gate.evaluate(FIRST_START);
  assert(atStart.allowed);
  assertEquals(atStart.closesAtEpochMs, FIRST_END);

  const atClose = gate.evaluate(FIRST_END);
  assert(!atClose.allowed);
  assertEquals(atClose.reason, 'closed');
  assertEquals(atClose.nextOpensAtEpochMs, SECOND_START);
});

Deno.test('fails closed before, after, and on invalid wall-clock instants', () => {
  const gate = createGate();

  const before = gate.evaluate(FIRST_START - 1);
  assert(!before.allowed);
  assertEquals(before.nextOpensAtEpochMs, FIRST_START);

  const after = gate.evaluate(SECOND_END);
  assert(!after.allowed);
  assertEquals(after.nextOpensAtEpochMs, undefined);

  const invalid = gate.evaluate(Number.NaN);
  assert(!invalid.allowed);
  assertEquals(invalid.reason, 'invalid-time');
});

Deno.test('rejects invalid and overlapping operating-window configuration', () => {
  const invalidBoundary = createOperatingWindowGate([
    { startsAtEpochMs: Number.NaN, endsAtEpochMs: FIRST_END },
  ]);
  assert(!invalidBoundary.ok);
  assertEquals(invalidBoundary.error.code, 'invalid-boundary');

  const invalidOrder = createOperatingWindowGate([
    { startsAtEpochMs: FIRST_END, endsAtEpochMs: FIRST_START },
  ]);
  assert(!invalidOrder.ok);
  assertEquals(invalidOrder.error.code, 'invalid-order');

  const overlap = createOperatingWindowGate([
    { startsAtEpochMs: FIRST_START, endsAtEpochMs: FIRST_END },
    { startsAtEpochMs: FIRST_END - 1, endsAtEpochMs: SECOND_END },
  ]);
  assert(!overlap.ok);
  assertEquals(overlap.error.code, 'overlapping-windows');
});

function createGate() {
  const result = createOperatingWindowGate([
    { startsAtEpochMs: FIRST_START, endsAtEpochMs: FIRST_END },
    { startsAtEpochMs: SECOND_START, endsAtEpochMs: SECOND_END },
  ]);
  if (!result.ok) {
    throw new Error(`Unexpected operating-window error: ${result.error.code}`);
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
