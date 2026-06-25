import { createPoolNormalizer } from '../src/normalization/pool-normalizer.ts';
import { createSnapshotStore } from '../src/snapshot/snapshot-store.ts';
import { normalizerOptions, sourceCollection } from './support/pool-test-data.ts';

Deno.test('snapshot store owns a deeply immutable copy and increments data generations', () => {
  const candidate = normalizedCandidate();
  const store = createSnapshotStore();

  const first = store.publish(candidate, Date.parse('2026-06-24T12:10:00.000Z'));
  const second = store.publish(candidate, Date.parse('2026-06-24T12:15:00.000Z'));

  assert(first.ok && second.ok, 'Expected valid candidates to publish');
  assertEquals(first.snapshot.generation, 1);
  assertEquals(second.snapshot.generation, 2);
  assertNotSame(first.snapshot, second.snapshot);
  assertNotSame(first.snapshot.pools, candidate.pools);
  assert(Object.isFrozen(first.snapshot), 'Expected snapshot object to be frozen');
  assert(Object.isFrozen(first.snapshot.pools), 'Expected pool collection to be frozen');
  assert(Object.isFrozen(first.snapshot.pools[0]?.operating.availableAreas));
  assert(Object.isFrozen(first.snapshot.pools[0]?.capacity));
});

Deno.test('snapshot store leaves the current reference unchanged after invalid publication', () => {
  const store = createSnapshotStore();
  const first = store.publish(
    normalizedCandidate(),
    Date.parse('2026-06-24T12:10:00.000Z'),
  );
  assert(first.ok, 'Expected initial publication');

  const rejected = store.publish(normalizedCandidate(), Number.NaN);

  assert(!rejected.ok, 'Expected invalid checked time rejection');
  assertEquals(rejected.error.code, 'invalid-checked-at');
  assertSame(store.current(), first.snapshot);
});

function normalizedCandidate() {
  const configured = createPoolNormalizer(normalizerOptions());
  if (!configured.ok) {
    throw new Error(`Unexpected normalizer configuration error: ${configured.error.code}`);
  }
  const normalized = configured.normalizer.normalize(sourceCollection());
  if (!normalized.ok) {
    throw new Error(`Unexpected normalization error: ${normalized.error.code}`);
  }
  return normalized.value;
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

function assertSame(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error('Expected references to be identical');
  }
}

function assertNotSame(actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    throw new Error('Expected references to differ');
  }
}
