import type {
  ApiRepresentationCache,
  ApiRepresentationCacheReadStatus,
} from '../cache/api-representation-cache.ts';
import type { ApiEndpointId } from '../http/endpoint-descriptors.ts';
import type { SnapshotStore } from '../snapshot/snapshot-store.ts';
import type { ArcGisAttemptEvent, ArcGisEventSink, ArcGisOperation } from './arcgis-events.ts';

export type ApiMetricRoute = ApiEndpointId | 'unknown';
export type ApiMetricStatus = 200 | 204 | 304 | 400 | 404 | 405 | 406 | 415 | 429 | 500 | 503;
export type MetricResult = 'success' | 'not-modified' | 'failure';
export type CacheMetricResult = 'hit' | 'miss' | 'coalesced' | 'eviction';

export interface OperationalMetrics {
  recordArcGisAttempt(event: ArcGisAttemptEvent): void;
  recordApiRequest(route: ApiMetricRoute, status: ApiMetricStatus, durationSeconds: number): void;
  recordCacheResult(result: CacheMetricResult, count?: number): void;
  observeRuntime(
    snapshotStore: SnapshotStore,
    cache: ApiRepresentationCache,
    nowEpochMs: number,
  ): void;
  snapshot(): OperationalMetricsSnapshot;
}

export interface MetricCounterSnapshot {
  readonly name:
    | 'arcgis_poll_total'
    | 'arcgis_outbound_attempt_total'
    | 'arcgis_schema_drift_total'
    | 'pool_records_accepted'
    | 'pool_records_rejected'
    | 'api_representation_cache_total'
    | 'api_requests_total';
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricGaugeSnapshot {
  readonly name:
    | 'arcgis_consecutive_failures'
    | 'snapshot_age_seconds'
    | 'snapshot_generation'
    | 'api_representation_cache_entries'
    | 'api_representation_cache_bytes';
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricHistogramSnapshot {
  readonly name:
    | 'arcgis_poll_duration_seconds'
    | 'arcgis_response_bytes'
    | 'api_request_duration_seconds';
  readonly labels: Readonly<Record<string, string>>;
  readonly count: number;
  readonly sum: number;
  readonly max: number;
}

export interface OperationalMetricsSnapshot {
  readonly counters: readonly MetricCounterSnapshot[];
  readonly gauges: readonly MetricGaugeSnapshot[];
  readonly histograms: readonly MetricHistogramSnapshot[];
}

interface MutableHistogram {
  count: number;
  sum: number;
  max: number;
}

/** Aggregates bounded operational metrics in process without emitting logs or exposing HTTP state. */
export function createOperationalMetrics(): OperationalMetrics {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const histograms = new Map<string, MutableHistogram>();

  const metrics: OperationalMetrics = {
    recordArcGisAttempt(event: ArcGisAttemptEvent): void {
      try {
        const result = event.result;
        increment(
          counters,
          key('arcgis_outbound_attempt_total', {
            operation: event.operation,
            result,
          }),
        );
        if (event.operation === 'collection') {
          increment(counters, key('arcgis_poll_total', { result }));
          observe(histograms, key('arcgis_poll_duration_seconds'), event.durationMs / 1_000);
          setGauge(gauges, key('arcgis_consecutive_failures'), event.consecutiveFailures);
        }
        if (event.responseBytes !== undefined) {
          observe(
            histograms,
            key('arcgis_response_bytes', { operation: event.operation }),
            event.responseBytes,
          );
        }
        if (event.acceptedRecordCount !== undefined) {
          increment(counters, key('pool_records_accepted'), event.acceptedRecordCount);
        }
        if (event.rejectedRecordCount !== undefined) {
          increment(counters, key('pool_records_rejected'), event.rejectedRecordCount);
        }
        if (event.result === 'failure' && event.failureClass === 'validation') {
          increment(counters, key('arcgis_schema_drift_total', { operation: event.operation }));
        }
      } catch {
        // Metrics are deliberately outside source-request control flow.
      }
    },

    recordApiRequest(route, status, durationSeconds): void {
      try {
        increment(counters, key('api_requests_total', { route, status: String(status) }));
        observe(histograms, key('api_request_duration_seconds', { route }), durationSeconds);
      } catch {
        // Metrics are deliberately outside request control flow.
      }
    },

    recordCacheResult(result, count = 1): void {
      try {
        if (Number.isSafeInteger(count) && count > 0) {
          increment(counters, key('api_representation_cache_total', { result }), count);
        }
      } catch {
        // Metrics are deliberately outside cache control flow.
      }
    },

    observeRuntime(snapshotStore, cache, nowEpochMs): void {
      try {
        const cacheStats = cache.stats();
        setGauge(gauges, key('api_representation_cache_entries'), cacheStats.entries);
        setGauge(gauges, key('api_representation_cache_bytes'), cacheStats.bytes);
        const snapshot = snapshotStore.current();
        if (snapshot !== undefined) {
          const checkedAtEpochMs = Date.parse(snapshot.lastCheckedAt);
          if (Number.isFinite(checkedAtEpochMs) && Number.isFinite(nowEpochMs)) {
            setGauge(
              gauges,
              key('snapshot_age_seconds'),
              Math.max(0, (nowEpochMs - checkedAtEpochMs) / 1_000),
            );
          }
          setGauge(gauges, key('snapshot_generation'), snapshot.generation);
        }
      } catch {
        // Metrics are deliberately outside snapshot and cache control flow.
      }
    },

    snapshot(): OperationalMetricsSnapshot {
      return Object.freeze({
        counters: freezeCounters(counters),
        gauges: freezeGauges(gauges),
        histograms: freezeHistograms(histograms),
      });
    },
  };
  return Object.freeze(metrics);
}

/** Preserves the single operational event while deriving in-process source metrics. */
export function createMetricsArcGisEventSink(
  eventSink: ArcGisEventSink,
  metrics: OperationalMetrics,
): ArcGisEventSink {
  return Object.freeze({
    emit(event: ArcGisAttemptEvent): void {
      try {
        eventSink.emit(event);
      } catch {
        // Sink implementations are expected to be safe, but the decorator remains defensive.
      }
      try {
        metrics.recordArcGisAttempt(event);
      } catch {
        // Metrics never alter source-attempt handling.
      }
    },
  });
}

/** Adds cache outcome and bounded eviction metrics without changing cache behavior. */
export function createMetricsApiRepresentationCache(
  cache: ApiRepresentationCache,
  metrics: OperationalMetrics,
): ApiRepresentationCache {
  const instrumentedCache: ApiRepresentationCache = {
    activateGeneration: (generation) => cache.activateGeneration(generation),
    async getOrCreate(keyValue, factory) {
      const before = cache.stats();
      const result = await cache.getOrCreate(keyValue, factory);
      if (result.ok) {
        recordCacheRead(metrics, result.status);
        if (result.status === 'miss') {
          const after = cache.stats();
          const evictions = Math.max(0, before.entries + 1 - after.entries);
          if (evictions > 0) {
            safeRecordCacheResult(metrics, 'eviction', evictions);
          }
        }
      }
      return result;
    },
    invalidate: (scopes) => cache.invalidate(scopes),
    stats: () => cache.stats(),
  };
  return Object.freeze(instrumentedCache);
}

function recordCacheRead(
  metrics: OperationalMetrics,
  result: ApiRepresentationCacheReadStatus,
): void {
  safeRecordCacheResult(metrics, result);
}

function safeRecordCacheResult(
  metrics: OperationalMetrics,
  result: CacheMetricResult,
  count?: number,
): void {
  try {
    metrics.recordCacheResult(result, count);
  } catch {
    // Metrics never alter cache handling.
  }
}

function increment(values: Map<string, number>, metricKey: string, amount = 1): void {
  if (!Number.isFinite(amount) || amount < 0) {
    return;
  }
  values.set(metricKey, (values.get(metricKey) ?? 0) + amount);
}

function setGauge(values: Map<string, number>, metricKey: string, value: number): void {
  if (Number.isFinite(value) && value >= 0) {
    values.set(metricKey, value);
  }
}

function observe(values: Map<string, MutableHistogram>, metricKey: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  const histogram = values.get(metricKey) ?? { count: 0, sum: 0, max: 0 };
  histogram.count += 1;
  histogram.sum += value;
  histogram.max = Math.max(histogram.max, value);
  values.set(metricKey, histogram);
}

function key(name: string, labels: Readonly<Record<string, string>> = {}): string {
  const normalizedLabels = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return JSON.stringify([name, normalizedLabels]);
}

function parseKey(
  metricKey: string,
): Readonly<{ name: string; labels: Readonly<Record<string, string>> }> {
  const [name, entries] = JSON.parse(metricKey) as [string, Array<[string, string]>];
  return Object.freeze({ name, labels: Object.freeze(Object.fromEntries(entries)) });
}

function freezeCounters(values: ReadonlyMap<string, number>): readonly MetricCounterSnapshot[] {
  return Object.freeze(
    [...values.entries()].sort().map(([metricKey, value]) => {
      const parsed = parseKey(metricKey);
      return Object.freeze({ ...parsed, value }) as MetricCounterSnapshot;
    }),
  );
}

function freezeGauges(values: ReadonlyMap<string, number>): readonly MetricGaugeSnapshot[] {
  return Object.freeze(
    [...values.entries()].sort().map(([metricKey, value]) => {
      const parsed = parseKey(metricKey);
      return Object.freeze({ ...parsed, value }) as MetricGaugeSnapshot;
    }),
  );
}

function freezeHistograms(
  values: ReadonlyMap<string, MutableHistogram>,
): readonly MetricHistogramSnapshot[] {
  return Object.freeze(
    [...values.entries()].sort().map(([metricKey, value]) => {
      const parsed = parseKey(metricKey);
      return Object.freeze({ ...parsed, ...value }) as MetricHistogramSnapshot;
    }),
  );
}

export function isApiMetricStatus(status: number): status is ApiMetricStatus {
  return status === 200 || status === 204 || status === 304 || status === 400 || status === 404 ||
    status === 405 || status === 406 || status === 415 || status === 429 || status === 500 ||
    status === 503;
}

export function isArcGisMetricOperation(operation: string): operation is ArcGisOperation {
  return operation === 'collection' || operation === 'metadata' ||
    operation === 'restricted-diagnostic';
}
