import { createPoolNormalizer } from '../src/normalization/pool-normalizer.ts';
import { createCollectionSnapshotPublisher } from '../src/snapshot/collection-snapshot-publisher.ts';
import { createSnapshotStore } from '../src/snapshot/snapshot-store.ts';
import { normalizerOptions, sourceCollection } from './support/pool-test-data.ts';

const FIRST_CHECK = Date.parse('2026-06-24T12:10:00.000Z');
const SECOND_CHECK = Date.parse('2026-06-24T12:15:00.000Z');

Deno.test('snapshot publisher publishes atomically and retains prior snapshot on rejection', () => {
  const context = createContext();
  const first = context.publisher.apply(success(sourceCollection(), '"v1"'), FIRST_CHECK);
  assert(first.ok && first.status === 'published', 'Expected initial publication');
  const acceptedSnapshot = context.store.current();
  assert(acceptedSnapshot !== undefined, 'Expected current snapshot');

  const rejected = context.publisher.apply(
    success(sourceCollection({ firstStatus: 'Unreviewed Status' }), '"v2"'),
    SECOND_CHECK,
  );

  assert(!rejected.ok, 'Expected normalization rejection');
  assertEquals(rejected.error.code, 'normalization');
  assertSame(context.store.current(), acceptedSnapshot);
  assertEquals(context.publisher.sourceEtag(), '"v1"');
});

Deno.test('snapshot publisher refreshes only harvester freshness on 304', () => {
  const context = createContext();
  const first = context.publisher.apply(success(sourceCollection(), '"v1"'), FIRST_CHECK);
  assert(first.ok && first.status === 'published', 'Expected initial publication');
  const firstSnapshot = first.snapshot;

  const refreshed = context.publisher.apply(notModified(), SECOND_CHECK);

  assert(refreshed.ok && refreshed.status === 'refreshed', 'Expected 304 refresh');
  assertEquals(refreshed.snapshot.generation, firstSnapshot.generation);
  assertSame(refreshed.snapshot.pools, firstSnapshot.pools);
  assertEquals(refreshed.snapshot.lastCheckedAt, '2026-06-24T12:15:00.000Z');
  assertEquals(
    refreshed.snapshot.pools[0]?.sourceReportedAt,
    firstSnapshot.pools[0]?.sourceReportedAt,
  );
  assertEquals(context.publisher.sourceEtag(), '"v1"');
});

Deno.test('snapshot publisher rejects 304 before initial snapshot', () => {
  const context = createContext();

  const result = context.publisher.apply(notModified(), FIRST_CHECK);

  assert(!result.ok, 'Expected a validator response without retained data to fail closed');
  assertEquals(result.error.code, 'no-snapshot');
  assertEquals(context.store.current(), undefined);
});

Deno.test('snapshot publisher clears stale source ETag when accepted response omits one', () => {
  const context = createContext();
  const first = context.publisher.apply(success(sourceCollection(), '"v1"'), FIRST_CHECK);
  assert(first.ok, 'Expected first publication');

  const second = context.publisher.apply(success(sourceCollection()), SECOND_CHECK);

  assert(second.ok, 'Expected second publication');
  assertEquals(context.publisher.sourceEtag(), undefined);
});

function createContext() {
  const configured = createPoolNormalizer(normalizerOptions());
  if (!configured.ok) {
    throw new Error(`Unexpected normalizer configuration error: ${configured.error.code}`);
  }
  const store = createSnapshotStore();
  return Object.freeze({
    store,
    publisher: createCollectionSnapshotPublisher(configured.normalizer, store),
  });
}

function success(
  collection: ReturnType<typeof sourceCollection>,
  etag?: string,
) {
  return Object.freeze({
    ok: true as const,
    result: 'success' as const,
    collection,
    ...(etag === undefined ? {} : { etag }),
  });
}

function notModified() {
  return Object.freeze({ ok: true as const, result: 'not-modified' as const });
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
