import { createApiRepresentationCache } from '../src/cache/api-representation-cache.ts';
import {
  ARCGIS_EVENT_SCHEMA_VERSION,
  type ArcGisAttemptEvent,
} from '../src/telemetry/arcgis-events.ts';
import {
  createMetricsApiRepresentationCache,
  createMetricsArcGisEventSink,
  createOperationalMetrics,
  type OperationalMetrics,
} from '../src/telemetry/operational-metrics.ts';

Deno.test('source metrics preserve one event and aggregate only bounded dimensions', () => {
  const metrics = createOperationalMetrics();
  const events: ArcGisAttemptEvent[] = [];
  const sink = createMetricsArcGisEventSink(
    Object.freeze({ emit: (event: ArcGisAttemptEvent) => events.push(event) }),
    metrics,
  );

  sink.emit(successEvent());

  assertEquals(events.length, 1);
  const snapshot = metrics.snapshot();
  assertMetric(snapshot.counters, 'arcgis_poll_total', { result: 'success' }, 1);
  assertMetric(
    snapshot.counters,
    'arcgis_outbound_attempt_total',
    { operation: 'collection', result: 'success' },
    1,
  );
  assertMetric(snapshot.counters, 'pool_records_accepted', {}, 2);
  assertMetric(snapshot.gauges, 'arcgis_consecutive_failures', {}, 0);
  const serialized = JSON.stringify(snapshot);
  for (
    const forbidden of [
      'https://services8.arcgis.com',
      'AssetID',
      'TEST-001',
      'x-forwarded-for',
      'synthetic exception',
    ]
  ) {
    assertEquals(serialized.includes(forbidden), false);
  }
});

Deno.test('cache metrics aggregate hit, miss, and eviction without changing cache behavior', async () => {
  const created = createApiRepresentationCache({ maxEntries: 1, maxBytes: 1_000 });
  assert(created.ok);
  const metrics = createOperationalMetrics();
  const cache = createMetricsApiRepresentationCache(created.cache, metrics);
  assert(cache.activateGeneration(1).ok);

  const first = await cache.getOrCreate(poolKey('first-pool'), () => ({ id: 'first-pool' }));
  const hit = await cache.getOrCreate(poolKey('first-pool'), () => ({ id: 'unexpected' }));
  const second = await cache.getOrCreate(poolKey('second-pool'), () => ({ id: 'second-pool' }));

  assert(first.ok && first.status === 'miss');
  assert(hit.ok && hit.status === 'hit');
  assert(second.ok && second.status === 'miss');
  const counters = metrics.snapshot().counters;
  assertMetric(counters, 'api_representation_cache_total', { result: 'miss' }, 2);
  assertMetric(counters, 'api_representation_cache_total', { result: 'hit' }, 1);
  assertMetric(counters, 'api_representation_cache_total', { result: 'eviction' }, 1);
  assertEquals(JSON.stringify(counters).includes('first-pool'), false);
  assertEquals(JSON.stringify(counters).includes('second-pool'), false);
});

Deno.test('source metrics and downstream sink failures cannot escape the decorator', () => {
  let eventCount = 0;
  const sink = createMetricsArcGisEventSink(
    Object.freeze({
      emit(): void {
        eventCount += 1;
        throw new Error('synthetic sink failure');
      },
    }),
    throwingMetrics(),
  );

  sink.emit(successEvent());
  assertEquals(eventCount, 1);
});

function successEvent(): ArcGisAttemptEvent {
  return Object.freeze({
    schemaVersion: ARCGIS_EVENT_SCHEMA_VERSION,
    eventCode: 'arcgis.attempt.succeeded',
    level: 'info',
    result: 'success',
    occurredAt: '2026-06-25T15:05:00.000Z',
    operation: 'collection',
    durationMs: 125,
    httpStatus: 200,
    responseBytes: 4096,
    validatorResult: 'accepted',
    acceptedRecordCount: 2,
    rejectedRecordCount: 0,
    consecutiveFailures: 0,
  });
}

function poolKey(poolId: string) {
  return Object.freeze({
    generation: 1,
    semanticEpoch: 0,
    route: 'pool' as const,
    poolId,
  });
}

function throwingMetrics(): OperationalMetrics {
  const fail = (): never => {
    throw new Error('synthetic metric failure');
  };
  return Object.freeze({
    recordArcGisAttempt: fail,
    recordApiRequest: fail,
    recordCacheResult: fail,
    observeRuntime: fail,
    snapshot: fail,
  });
}

function assertMetric(
  points: readonly Readonly<{
    name: string;
    labels: Readonly<Record<string, string>>;
    value: number;
  }>[],
  name: string,
  labels: Readonly<Record<string, string>>,
  value: number,
): void {
  const point = points.find((candidate) =>
    candidate.name === name && JSON.stringify(candidate.labels) === JSON.stringify(labels)
  );
  assert(point !== undefined, `Expected metric ${name}`);
  assertEquals(point.value, value);
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
