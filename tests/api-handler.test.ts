import {
  type ApiRepresentationCache,
  createApiRepresentationCache,
} from '../src/cache/api-representation-cache.ts';
import { PUBLIC_API_BASE_URL } from '../src/config/api-config.ts';
import {
  createSemanticFreshnessProjector,
  type SemanticFreshnessPolicy,
  type SemanticFreshnessProjector,
} from '../src/freshness/semantic-freshness-projector.ts';
import { createOperatingWindowGate } from '../src/harvesting/operating-window-gate.ts';
import { type ApiRequestHandler, createApiRequestHandler } from '../src/http/api-handler.ts';
import { API_ENDPOINTS } from '../src/http/endpoint-descriptors.ts';
import {
  createInboundRateLimiter,
  type InboundRateLimiter,
} from '../src/http/inbound-rate-limiter.ts';
import { API_FILTER_VALUES } from '../src/http/openapi-contract.ts';
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
  const readinessResponse = await harness.handler(request('/readyz'));
  assertEquals(readinessResponse.status, 200);
  assertEquals(
    await jsonObject(readinessResponse),
    {
      status: 'ready',
      snapshotState: 'current',
      collectionState: 'active',
      lastCheckedAt: '2026-06-24T12:10:00.000Z',
    },
  );
});

Deno.test('OpenAPI is deterministic, schema-bound, and matches the canonical HTTP surface', async () => {
  const enabled = createHarness();
  const first = await enabled.handler(request('/openapi/v1.json'));
  const second = await enabled.handler(request('/openapi/v1.json'));
  assertEquals(first.status, 200);
  const firstText = await first.text();
  assertEquals(firstText, await second.text());

  const document = JSON.parse(firstText) as Record<string, unknown>;
  assertEquals(document.openapi, '3.1.0');
  assertEquals(document.security, []);
  const paths = objectValue(document, 'paths');
  const documentedPaths = Object.keys(paths);
  assertEquals(
    documentedPaths,
    API_ENDPOINTS.filter((endpoint) => endpoint.id !== 'swagger').map((endpoint) => endpoint.path),
  );
  for (const endpoint of API_ENDPOINTS.filter((candidate) => candidate.id !== 'swagger')) {
    const pathItem = objectValue(paths, endpoint.path);
    assertEquals(Object.keys(pathItem), ['get', 'head', 'options']);
    const get = objectValue(pathItem, 'get');
    const head = objectValue(pathItem, 'head');
    const options = objectValue(pathItem, 'options');
    assertEquals(get.operationId, endpoint.id);
    assertEquals(head.operationId, `${endpoint.id}Head`);
    assertEquals(options.operationId, `${endpoint.id}Options`);
    assert(hasJsonSchemaResponse(get, '200'));
    assert(!responseValue(head, '200').content);
    assert(responseValue(options, '204').headers !== undefined);
  }

  const listPoolsGet = objectValue(objectValue(paths, '/v1/pools'), 'get');
  const filterParameters = listPoolsGet.parameters as readonly Record<string, unknown>[];
  assertEquals(
    filterParameters.map((parameter) => parameter.name),
    Object.keys(API_FILTER_VALUES),
  );
  for (const [name, values] of Object.entries(API_FILTER_VALUES)) {
    const parameter = filterParameters.find((candidate) => candidate.name === name);
    assert(parameter !== undefined);
    assertEquals(objectValue(parameter, 'schema').enum, values);
  }
  assertEquals(Object.keys(objectValue(listPoolsGet, 'responses')), [
    '200',
    '304',
    '400',
    '405',
    '406',
    '415',
    '429',
    '500',
    '503',
  ]);
  assertProblemSchemaResponse(listPoolsGet, '400');
  assertProblemSchemaResponse(listPoolsGet, '429');
  assertProblemSchemaResponse(listPoolsGet, '503');

  const components = objectValue(document, 'components');
  const schemas = objectValue(components, 'schemas');
  assertEquals(Object.keys(schemas), [
    'Snapshot',
    'PoolOperating',
    'PoolMaintenance',
    'PoolOccupancy',
    'Pool',
    'PoolsResponse',
    'PoolResponse',
    'ClosuresResponse',
    'HealthResponse',
    'ReadinessResponse',
    'ProblemDetails',
    'OpenApiDocument',
  ]);
  assertEquals(
    objectValue(schemas, 'ProblemDetails').example,
    {
      type: new URL('problems/invalid_filter', PUBLIC_API_BASE_URL).href,
      title: 'Bad Request',
      status: 400,
      detail: 'A query filter is unknown or invalid.',
      instance: '/v1/pools',
      code: 'invalid_filter',
    },
  );
  const serializedContract = JSON.stringify(document).toLowerCase();
  for (
    const rawField of [
      'assetid',
      'globalid',
      'editor',
      'geometry',
      'formlink',
      'attachments',
      'sourceurl',
    ]
  ) {
    assert(!serializedContract.includes(rawField), `OpenAPI exposed raw field ${rawField}`);
  }
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
  assertEquals(body.type, new URL(`problems/${code}`, PUBLIC_API_BASE_URL).href);
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
  if (Object.is(actual, expected)) {
    return;
  }
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

function assertNotEquals(actual: unknown, expected: unknown): void {
  if (actual === expected) {
    throw new Error(`Expected values to differ, both were ${String(actual)}`);
  }
}

function objectValue(
  object: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = object[key];
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function responseValue(
  operation: Readonly<Record<string, unknown>>,
  status: string,
): Record<string, unknown> {
  return objectValue(objectValue(operation, 'responses'), status);
}

function hasJsonSchemaResponse(
  operation: Readonly<Record<string, unknown>>,
  status: string,
): boolean {
  const content = objectValue(responseValue(operation, status), 'content');
  const media = objectValue(content, 'application/json');
  return '$ref' in objectValue(media, 'schema');
}

function assertProblemSchemaResponse(
  operation: Readonly<Record<string, unknown>>,
  status: string,
): void {
  const content = objectValue(responseValue(operation, status), 'content');
  const media = objectValue(content, 'application/problem+json');
  assertEquals(objectValue(media, 'schema').$ref, '#/components/schemas/ProblemDetails');
}
