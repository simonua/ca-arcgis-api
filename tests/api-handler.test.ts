import {
  type ApiRepresentationCache,
  createApiRepresentationCache,
} from '../src/cache/api-representation-cache.ts';
import {
  createSemanticFreshnessProjector,
  type SemanticFreshnessPolicy,
  type SemanticFreshnessProjector,
} from '../src/freshness/semantic-freshness-projector.ts';
import { createOperatingWindowGate } from '../src/harvesting/operating-window-gate.ts';
import { type ApiRequestHandler, createApiRequestHandler } from '../src/http/api-handler.ts';
import {
  createInboundRateLimiter,
  type InboundRateLimiter,
} from '../src/http/inbound-rate-limiter.ts';
import { createPoolNormalizer } from '../src/normalization/pool-normalizer.ts';
import { createSnapshotStore, type SnapshotStore } from '../src/snapshot/snapshot-store.ts';
import { normalizerOptions, sourceCollection } from './support/pool-test-data.ts';

const MINUTE_MS = 60_000;
const DEFAULT_NOW = Date.parse('2026-06-24T12:10:00.000Z');
const POLICY: SemanticFreshnessPolicy = Object.freeze({
  snapshotCurrentMs: 10 * MINUTE_MS,
  snapshotMaxStaleMs: 60 * MINUTE_MS,
  attendanceCurrentMs: 15 * MINUTE_MS,
  statusCurrentMs: 30 * MINUTE_MS,
  statusMaxStaleMs: 120 * MINUTE_MS,
});

Deno.test('health remains live while readiness and data fail closed without a snapshot', async () => {
  const harness = createHarness({ publishSnapshot: false, requestsPerWindow: 1 });

  assertEquals((await harness.handler(request('/healthz'))).status, 200);
  assertEquals((await harness.handler(request('/healthz'))).status, 200);

  const readiness = await harness.handler(request('/readyz'));
  assertProblem(await readiness, 503, 'snapshot_unavailable');
  const pools = await harness.handler(request('/v1/pools'));
  assertProblem(await pools, 503, 'snapshot_unavailable');
});

Deno.test('readiness and data fail closed after all retained records expire', async () => {
  const harness = createHarness();
  harness.setNow(DEFAULT_NOW + 3 * 60 * MINUTE_MS);

  assertEquals((await harness.handler(request('/healthz'))).status, 200);
  assertProblem(
    await harness.handler(request('/readyz')),
    503,
    'snapshot_unavailable',
  );
  assertProblem(
    await harness.handler(request('/v1/pools')),
    503,
    'snapshot_unavailable',
  );
});

Deno.test('API validates methods, bodies, media ranges, routes, and exact filters', async () => {
  const harness = createHarness();

  const method = await harness.handler(request('/v1/pools', { method: 'POST' }));
  assertProblem(await method, 405, 'method_not_allowed');
  assertEquals(method.headers.get('allow'), 'GET, HEAD, OPTIONS');

  const body = await harness.handler(request('/v1/pools', {
    headers: { 'content-type': 'application/json' },
  }));
  assertProblem(await body, 415, 'unsupported_media_type');

  const unacceptable = await harness.handler(request('/v1/pools', {
    headers: { accept: 'application/json;q=0, text/html' },
  }));
  assertProblem(await unacceptable, 406, 'not_acceptable');

  assertProblem(await harness.handler(request('/v1/unknown')), 404, 'route_not_found');
  assertProblem(
    await harness.handler(request('/v1/pools?sourceUrl=https://example.test')),
    400,
    'invalid_filter',
  );
  assertProblem(
    await harness.handler(request('/v1/pools?locationType=outdoor&locationType=indoor')),
    400,
    'invalid_filter',
  );
});

Deno.test('API exposes only normalized filtered pools and active closures', async () => {
  const harness = createHarness();

  const poolsResponse = await harness.handler(request('/v1/pools?locationType=outdoor'));
  assertEquals(poolsResponse.status, 200);
  const pools = await jsonObject(poolsResponse);
  const listedPools = pools.pools as readonly Record<string, unknown>[];
  assertEquals(listedPools.length, 1);
  assertEquals(listedPools[0]?.id, 'river-hill');
  assertEquals(listedPools[0]?.name, 'River Hill Pool');
  assertEquals(listedPools[0]?.sourceStatus, undefined);
  assertEquals(listedPools[0]?.assetId, undefined);

  const closuresResponse = await harness.handler(request('/v1/closures?closureKind=maintenance'));
  assertEquals(closuresResponse.status, 200);
  const closures = await jsonObject(closuresResponse);
  const listedClosures = closures.closures as readonly Record<string, unknown>[];
  assertEquals(listedClosures.length, 1);
  assertEquals(listedClosures[0]?.id, 'athletic-club');

  assertProblem(
    await harness.handler(request('/v1/pools/not-configured')),
    404,
    'pool_not_found',
  );
  assertEquals((await harness.handler(request('/v1/pools/river-hill'))).status, 200);
});

Deno.test('API preserves CORS, HEAD, ETag, and source-refresh cache semantics', async () => {
  const harness = createHarness();
  const headers = { origin: 'https://app.example.test' };

  const first = await harness.handler(request('/v1/pools', { headers }));
  assertEquals(first.status, 200);
  assertEquals(first.headers.get('access-control-allow-origin'), 'https://app.example.test');
  assertEquals(first.headers.get('vary'), 'Origin');
  const firstEtag = first.headers.get('etag');
  assert(firstEtag !== null);
  const firstBody = await first.text();

  const head = await harness.handler(request('/v1/pools', { method: 'HEAD', headers }));
  assertEquals(head.status, 200);
  assertEquals(await head.text(), '');
  assertEquals(
    head.headers.get('content-length'),
    String(new TextEncoder().encode(firstBody).byteLength),
  );

  const notModified = await harness.handler(request('/v1/pools', {
    headers: { ...headers, 'if-none-match': `W/${firstEtag}` },
  }));
  assertEquals(notModified.status, 304);
  assertEquals(await notModified.text(), '');

  const refreshed = harness.snapshotStore.refresh(DEFAULT_NOW + MINUTE_MS);
  assert(refreshed.ok);
  harness.setNow(DEFAULT_NOW + MINUTE_MS);
  const afterRefresh = await harness.handler(request('/v1/pools', {
    headers: { 'if-none-match': firstEtag },
  }));
  assertEquals(afterRefresh.status, 200);
  assertNotEquals(afterRefresh.headers.get('etag'), firstEtag);
  const refreshedBody = await jsonObject(afterRefresh);
  const snapshot = refreshedBody.snapshot as Record<string, unknown>;
  assertEquals(snapshot.lastCheckedAt, '2026-06-24T12:11:00.000Z');
});

Deno.test('API limits one ACA client despite spoofed left forwarding values', async () => {
  const harness = createHarness({ requestsPerWindow: 1 });

  const first = await harness.handler(request('/v1/pools', {
    headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.8' },
  }));
  assertEquals(first.status, 200);
  const limited = await harness.handler(request('/v1/pools', {
    headers: { 'x-forwarded-for': '198.51.100.2, 203.0.113.8' },
  }));
  assertProblem(await limited, 429, 'client_rate_limited');
  assertEquals(limited.headers.get('retry-after'), '60');

  assertEquals((await harness.handler(request('/healthz'))).status, 200);
  assertEquals((await harness.handler(request('/readyz'))).status, 200);
});

Deno.test('OpenAPI is deterministic and disabled discovery routes are absent', async () => {
  const enabled = createHarness();
  const first = await enabled.handler(request('/openapi/v1.json'));
  const second = await enabled.handler(request('/openapi/v1.json'));
  assertEquals(first.status, 200);
  assertEquals(await first.text(), await second.text());
  assertProblem(await enabled.handler(request('/swagger')), 404, 'route_not_found');

  const disabled = createHarness({ openApiEnabled: false });
  assertProblem(
    await disabled.handler(request('/openapi/v1.json')),
    404,
    'route_not_found',
  );
});

interface Harness {
  readonly handler: ApiRequestHandler;
  readonly snapshotStore: SnapshotStore;
  setNow(value: number): void;
}

function createHarness(
  options: Readonly<{
    publishSnapshot?: boolean;
    requestsPerWindow?: number;
    openApiEnabled?: boolean;
  }> = {},
): Harness {
  let nowEpochMs = DEFAULT_NOW;
  let nowMonotonicMs = 1_000;
  const snapshotStore = createSnapshotStore();
  if (options.publishSnapshot !== false) {
    publishSyntheticSnapshot(snapshotStore, nowEpochMs);
  }
  const handler = createApiRequestHandler({
    snapshotStore,
    freshnessProjector: configuredProjector(),
    representationCache: configuredCache(),
    rateLimiter: configuredLimiter(options.requestsPerWindow ?? 100),
    knownPoolIds: ['river-hill', 'athletic-club'],
    allowedOrigins: ['https://app.example.test'],
    nowEpochMs: () => nowEpochMs,
    nowMonotonicMs: () => nowMonotonicMs,
    openApiEnabled: options.openApiEnabled ?? true,
  });
  return Object.freeze({
    handler,
    snapshotStore,
    setNow(value: number): void {
      nowEpochMs = value;
      nowMonotonicMs += 1;
    },
  });
}

function publishSyntheticSnapshot(store: SnapshotStore, checkedAtEpochMs: number): void {
  const configured = createPoolNormalizer(normalizerOptions());
  if (!configured.ok) {
    throw new Error(`Unexpected normalizer configuration error: ${configured.error.code}`);
  }
  const normalized = configured.normalizer.normalize(sourceCollection());
  if (!normalized.ok) {
    throw new Error(`Unexpected normalization error: ${normalized.error.code}`);
  }
  const published = store.publish(normalized.value, checkedAtEpochMs);
  if (!published.ok) {
    throw new Error(`Unexpected snapshot error: ${published.error.code}`);
  }
}

function configuredProjector(): SemanticFreshnessProjector {
  const gateResult = createOperatingWindowGate([{
    startsAtEpochMs: Date.parse('2026-06-24T00:00:00.000Z'),
    endsAtEpochMs: Date.parse('2026-06-26T00:00:00.000Z'),
  }]);
  if (!gateResult.ok) {
    throw new Error(`Unexpected operating-window error: ${gateResult.error.code}`);
  }
  const result = createSemanticFreshnessProjector(POLICY, gateResult.gate);
  if (!result.ok) {
    throw new Error(`Unexpected freshness error: ${result.error.code}`);
  }
  return result.projector;
}

function configuredCache(): ApiRepresentationCache {
  const result = createApiRepresentationCache({ maxEntries: 32, maxBytes: 64_000 });
  if (!result.ok) {
    throw new Error(`Unexpected cache error: ${result.error.code}`);
  }
  return result.cache;
}

function configuredLimiter(requestsPerWindow: number): InboundRateLimiter {
  const result = createInboundRateLimiter({
    requestsPerWindow,
    windowMs: 60_000,
    maxClientPartitions: 32,
  });
  if (!result.ok) {
    throw new Error(`Unexpected limiter error: ${result.error.code}`);
  }
  return result.limiter;
}

function request(
  path: string,
  init: Readonly<{
    method?: string;
    headers?: HeadersInit;
  }> = {},
): Request {
  return new Request(`https://api.example.test${path}`, init);
}

async function assertProblem(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  assertEquals(response.status, status);
  assertEquals(response.headers.get('content-type'), 'application/problem+json; charset=utf-8');
  const body = await jsonObject(response);
  assertEquals(body.code, code);
  assertEquals(body.status, status);
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
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

function assertNotEquals(actual: unknown, expected: unknown): void {
  if (actual === expected) {
    throw new Error(`Expected values to differ, both were ${String(actual)}`);
  }
}
