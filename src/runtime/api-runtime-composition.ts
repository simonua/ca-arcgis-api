import {
  type ApiRepresentationCacheOptions,
  createApiRepresentationCache,
} from '../cache/api-representation-cache.ts';
import type { SemanticFreshnessProjector } from '../freshness/semantic-freshness-projector.ts';
import type { CollectionSchedulerRunner } from '../harvesting/collection-scheduler-runner.ts';
import { type ApiRequestHandler, createApiRequestHandler } from '../http/api-handler.ts';
import {
  createInboundRateLimiter,
  type InboundRateLimitOptions,
} from '../http/inbound-rate-limiter.ts';
import type { SnapshotStore } from '../snapshot/snapshot-store.ts';
import {
  createMetricsApiRepresentationCache,
  createOperationalMetrics,
  type OperationalMetrics,
} from '../telemetry/operational-metrics.ts';
import { type ApiRuntime, type ApiRuntimeServerFactory, createApiRuntime } from './api-runtime.ts';

export interface ApiRuntimeCompositionOptions {
  readonly snapshotStore: SnapshotStore;
  readonly freshnessProjector: SemanticFreshnessProjector;
  readonly knownPoolIds: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly responseCache: ApiRepresentationCacheOptions;
  readonly inboundRateLimit: InboundRateLimitOptions;
  readonly nowEpochMs: () => number;
  readonly nowMonotonicMs: () => number;
  readonly metricsNowEpochMs?: () => number;
  readonly metricsNowMonotonicMs?: () => number;
  readonly openApiEnabled: boolean;
  readonly swaggerDocument?: Uint8Array;
  readonly serverFactory: ApiRuntimeServerFactory;
  readonly schedulerRunner?: CollectionSchedulerRunner;
  readonly metrics?: OperationalMetrics;
}

export type ApiRuntimeCompositionResult =
  | Readonly<{
    ok: true;
    runtime: ApiRuntime;
    handler: ApiRequestHandler;
    metrics: OperationalMetrics;
  }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code: 'invalid-response-cache-config' | 'invalid-rate-limit-config';
      reason: string;
    }>;
  }>;

/** Assembles the API from reviewed inputs without reading environment or starting side effects. */
export function composeApiRuntime(
  options: ApiRuntimeCompositionOptions,
): ApiRuntimeCompositionResult {
  const cacheResult = createApiRepresentationCache(options.responseCache);
  if (!cacheResult.ok) {
    return failure('invalid-response-cache-config', cacheResult.error.code);
  }
  const limiterResult = createInboundRateLimiter(options.inboundRateLimit);
  if (!limiterResult.ok) {
    return failure('invalid-rate-limit-config', limiterResult.error.code);
  }

  const metrics = options.metrics ?? createOperationalMetrics();
  const representationCache = createMetricsApiRepresentationCache(cacheResult.cache, metrics);
  const handler = createApiRequestHandler({
    snapshotStore: options.snapshotStore,
    freshnessProjector: options.freshnessProjector,
    representationCache,
    rateLimiter: limiterResult.limiter,
    knownPoolIds: options.knownPoolIds,
    allowedOrigins: options.allowedOrigins,
    nowEpochMs: options.nowEpochMs,
    nowMonotonicMs: options.nowMonotonicMs,
    ...(options.metricsNowEpochMs === undefined
      ? {}
      : { metricsNowEpochMs: options.metricsNowEpochMs }),
    ...(options.metricsNowMonotonicMs === undefined
      ? {}
      : { metricsNowMonotonicMs: options.metricsNowMonotonicMs }),
    openApiEnabled: options.openApiEnabled,
    metrics,
    ...(options.swaggerDocument === undefined ? {} : { swaggerDocument: options.swaggerDocument }),
  });
  const runtime = createApiRuntime({
    handler,
    serverFactory: options.serverFactory,
    ...(options.schedulerRunner === undefined ? {} : { schedulerRunner: options.schedulerRunner }),
  });
  return Object.freeze({ ok: true, runtime, handler, metrics });
}

function failure(
  code: 'invalid-response-cache-config' | 'invalid-rate-limit-config',
  reason: string,
): Extract<ApiRuntimeCompositionResult, { ok: false }> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, reason }) });
}
