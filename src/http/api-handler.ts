import type {
  ApiRepresentationCache,
  ApiRepresentationFilters,
  ApiRepresentationKey,
} from '../cache/api-representation-cache.ts';
import type { PoolAccess, PoolClosureKind, PoolLocationType } from '../contracts/pool-snapshot.ts';
import { isPoolApiId } from '../contracts/pool-identity.ts';
import type {
  FreshnessState,
  SemanticFreshnessProjection,
  SemanticFreshnessProjector,
} from '../freshness/semantic-freshness-projector.ts';
import type { SnapshotStore } from '../snapshot/snapshot-store.ts';
import {
  type ApiMetricRoute,
  isApiMetricStatus,
  type OperationalMetrics,
} from '../telemetry/operational-metrics.ts';
import {
  createClosuresRepresentation,
  createPoolRepresentation,
  createPoolsRepresentation,
  hasServiceableSnapshot,
} from './api-representations.ts';
import { resolveClientAddress } from './client-address.ts';
import {
  createOpenApiDocument,
  matchApiEndpoint,
  type MatchedApiEndpoint,
} from './endpoint-descriptors.ts';
import type { InboundRateLimiter } from './inbound-rate-limiter.ts';
import { API_FILTER_VALUES } from './openapi-contract.ts';
import { type ApiProblemCode, createProblemResponse } from './problem-details.ts';

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const PUBLIC_CACHE_MAX_AGE_SECONDS = 60;
const DEFAULT_MAX_URL_CHARS = 2_048;
const DEFAULT_MAX_HEADER_BYTES = 16_384;
const FILTERS = Object.freeze({
  locationType: new Set<PoolLocationType>(API_FILTER_VALUES.locationType),
  access: new Set<PoolAccess>(API_FILTER_VALUES.access),
  closureKind: new Set<PoolClosureKind>(API_FILTER_VALUES.closureKind),
  dataState: new Set<FreshnessState>(API_FILTER_VALUES.dataState),
});

export interface ApiRequestContext {
  readonly remoteAddress?: string;
}

export interface ApiRequestHandler {
  (request: Request, context?: ApiRequestContext): Promise<Response>;
}

export interface ApiRequestHandlerOptions {
  readonly snapshotStore: SnapshotStore;
  readonly freshnessProjector: SemanticFreshnessProjector;
  readonly representationCache: ApiRepresentationCache;
  readonly rateLimiter: InboundRateLimiter;
  readonly knownPoolIds: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly nowEpochMs: () => number;
  readonly nowMonotonicMs: () => number;
  readonly metricsNowEpochMs?: () => number;
  readonly metricsNowMonotonicMs?: () => number;
  readonly openApiEnabled: boolean;
  readonly swaggerDocument?: Uint8Array;
  readonly maxUrlChars?: number;
  readonly maxHeaderBytes?: number;
  readonly metrics?: OperationalMetrics;
}

/** Creates a read-only handler whose request path has no source-client dependency. */
export function createApiRequestHandler(options: ApiRequestHandlerOptions): ApiRequestHandler {
  const knownPoolIds = new Set(options.knownPoolIds);
  const allowedOrigins = new Set(options.allowedOrigins);
  const openApiDocument = createOpenApiDocument();
  let trackedGeneration: number | undefined;
  let semanticSignature: string | undefined;
  let semanticEpoch = 0;
  const metricsNowEpochMs = options.metricsNowEpochMs ?? Date.now;
  const metricsNowMonotonicMs = options.metricsNowMonotonicMs ?? (() => performance.now());

  const handleRequest = async function handleRequest(
    request: Request,
    context: ApiRequestContext = {},
  ): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return problem('invalid_request', '/', request.method === 'HEAD');
    }
    const corsHeaders = createCorsHeaders(request.headers.get('origin'), allowedOrigins);
    if (
      request.url.length > (options.maxUrlChars ?? DEFAULT_MAX_URL_CHARS) ||
      requestHeaderBytes(request.headers) > (options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES)
    ) {
      return problem('invalid_request', '/', request.method === 'HEAD', corsHeaders);
    }

    const match = matchApiEndpoint(url.pathname);
    if (match === undefined || !endpointEnabled(match)) {
      return problem('route_not_found', '/', request.method === 'HEAD', corsHeaders);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      const headers = new Headers(corsHeaders);
      headers.set('allow', ALLOWED_METHODS);
      return problem('method_not_allowed', match.descriptor.path, false, headers);
    }
    if (hasRequestBody(request)) {
      return problem(
        'unsupported_media_type',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }
    if (request.method === 'OPTIONS') {
      return optionsResponse(request, corsHeaders);
    }
    if (!acceptsJson(request.headers.get('accept'))) {
      return problem(
        'not_acceptable',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }

    if (isRateLimitedEndpoint(match)) {
      const clientKey = resolveClientAddress(
        request.headers.get('x-forwarded-for'),
        context.remoteAddress,
      );
      const decision = options.rateLimiter.acquire(clientKey, options.nowMonotonicMs());
      if (!decision.allowed) {
        return problem(
          'client_rate_limited',
          match.descriptor.path,
          request.method === 'HEAD',
          corsHeaders,
          decision.retryAfterSeconds,
        );
      }
    }

    const parsedFilters = parseFilters(url.searchParams, match);
    if (!parsedFilters.ok) {
      return problem(
        'invalid_filter',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }
    if (match.descriptor.id === 'health') {
      return jsonResponse(
        { status: 'live' },
        request.method === 'HEAD',
        corsHeaders,
        'no-store',
      );
    }
    if (match.descriptor.id === 'openApi') {
      return jsonResponse(
        openApiDocument,
        request.method === 'HEAD',
        corsHeaders,
        'public, max-age=3600',
      );
    }
    if (match.descriptor.id === 'swagger' && options.swaggerDocument !== undefined) {
      const headers = new Headers(corsHeaders);
      headers.set('content-type', 'text/html; charset=utf-8');
      headers.set('cache-control', 'no-store');
      headers.set('content-length', String(options.swaggerDocument.byteLength));
      return new Response(
        request.method === 'HEAD' ? null : responseBody(options.swaggerDocument),
        {
          status: 200,
          headers,
        },
      );
    }

    const nowEpochMs = options.nowEpochMs();
    const snapshot = options.snapshotStore.current();
    const projected = options.freshnessProjector.project(snapshot, nowEpochMs);
    if (!projected.ok) {
      return problem(
        'internal_error',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }
    if (match.descriptor.id === 'readiness') {
      return snapshot !== undefined && hasServiceableSnapshot(snapshot, projected.value)
        ? jsonResponse(
          {
            status: projected.value.snapshotState === 'current' ? 'ready' : 'degraded',
            snapshotState: projected.value.snapshotState,
            collectionState: projected.value.collectionState,
            lastCheckedAt: snapshot.lastCheckedAt,
            ...(projected.value.nextSourceAccessAt === undefined
              ? {}
              : { nextSourceAccessAt: projected.value.nextSourceAccessAt }),
          },
          request.method === 'HEAD',
          corsHeaders,
          'no-store',
        )
        : problem(
          'snapshot_unavailable',
          match.descriptor.path,
          request.method === 'HEAD',
          corsHeaders,
          30,
          projected.value.nextSourceAccessAt,
        );
    }

    const poolId = match.descriptor.id === 'getPool' ? match.poolId : undefined;
    if (poolId !== undefined && (!isPoolApiId(poolId) || !knownPoolIds.has(poolId))) {
      return problem(
        'pool_not_found',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }
    if (!hasServiceableSnapshot(snapshot, projected.value) || snapshot === undefined) {
      return problem(
        'snapshot_unavailable',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
        30,
        projected.value.nextSourceAccessAt,
      );
    }
    if (poolId !== undefined && !projected.value.pools.some((pool) => pool.id === poolId)) {
      return problem(
        'snapshot_unavailable',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
        30,
        projected.value.nextSourceAccessAt,
      );
    }

    const activated = options.representationCache.activateGeneration(snapshot.generation);
    if (!activated.ok) {
      return problem(
        'internal_error',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }
    const epoch = updateSemanticEpoch(snapshot.generation, snapshot.lastCheckedAt, projected.value);
    const key = representationKey(match, snapshot.generation, epoch, parsedFilters.filters);
    if (key === undefined) {
      return problem(
        'internal_error',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }
    const cached = await options.representationCache.getOrCreate(
      key,
      () => createRepresentation(match, snapshot, projected.value, parsedFilters.filters),
    );
    if (!cached.ok) {
      return problem(
        'internal_error',
        match.descriptor.path,
        request.method === 'HEAD',
        corsHeaders,
      );
    }

    const headers = new Headers(corsHeaders);
    headers.set('content-type', JSON_CONTENT_TYPE);
    headers.set('cache-control', publicCacheControl(projected.value, nowEpochMs));
    headers.set('etag', cached.representation.etag);
    if (matchesEtag(request.headers.get('if-none-match'), cached.representation.etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set('content-length', String(cached.representation.byteLength));
    return new Response(
      request.method === 'HEAD' ? null : responseBody(cached.representation.body),
      { status: 200, headers },
    );
  };

  if (options.metrics === undefined) {
    return handleRequest;
  }
  return async function handleRequestWithMetrics(
    request: Request,
    context: ApiRequestContext = {},
  ): Promise<Response> {
    const route = metricRoute(request);
    const startedAt = safeClock(metricsNowMonotonicMs);
    const response = await handleRequest(request, context);
    const completedAt = safeClock(metricsNowMonotonicMs);
    if (isApiMetricStatus(response.status)) {
      try {
        options.metrics?.recordApiRequest(
          route,
          response.status,
          startedAt === undefined || completedAt === undefined
            ? 0
            : Math.max(0, completedAt - startedAt) / 1_000,
        );
      } catch {
        // Metrics never alter API responses.
      }
    }
    try {
      options.metrics?.observeRuntime(
        options.snapshotStore,
        options.representationCache,
        metricsNowEpochMs(),
      );
    } catch {
      // Metrics never alter API responses.
    }
    return response;
  };

  function endpointEnabled(match: MatchedApiEndpoint): boolean {
    return (match.descriptor.id !== 'openApi' || options.openApiEnabled) &&
      (match.descriptor.id !== 'swagger' || options.swaggerDocument !== undefined);
  }

  function updateSemanticEpoch(
    generation: number,
    lastCheckedAt: string,
    projection: SemanticFreshnessProjection,
  ): number {
    const signature = semanticProjectionSignature(lastCheckedAt, projection);
    if (trackedGeneration !== generation) {
      trackedGeneration = generation;
      semanticSignature = signature;
      semanticEpoch = 0;
    } else if (semanticSignature !== signature) {
      semanticSignature = signature;
      semanticEpoch = semanticEpoch === Number.MAX_SAFE_INTEGER ? 0 : semanticEpoch + 1;
    }
    return semanticEpoch;
  }
}

function metricRoute(request: Request): ApiMetricRoute {
  try {
    return matchApiEndpoint(new URL(request.url).pathname)?.descriptor.id ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeClock(clock: () => number): number | undefined {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function createRepresentation(
  match: MatchedApiEndpoint,
  snapshot: NonNullable<ReturnType<SnapshotStore['current']>>,
  projection: SemanticFreshnessProjection,
  filters: ApiRepresentationFilters | undefined,
): Readonly<Record<string, unknown>> {
  if (match.descriptor.id === 'listPools') {
    return createPoolsRepresentation(snapshot, projection, filters);
  }
  if (match.descriptor.id === 'listClosures') {
    return createClosuresRepresentation(snapshot, projection, filters);
  }
  const pool = match.poolId === undefined
    ? undefined
    : createPoolRepresentation(snapshot, projection, match.poolId);
  if (pool === undefined) {
    throw new Error('Known pool is missing from the normalized snapshot.');
  }
  return pool;
}

function representationKey(
  match: MatchedApiEndpoint,
  generation: number,
  semanticEpoch: number,
  filters: ApiRepresentationFilters | undefined,
): ApiRepresentationKey | undefined {
  if (match.descriptor.id === 'getPool' && match.poolId !== undefined) {
    return Object.freeze({ generation, semanticEpoch, route: 'pool', poolId: match.poolId });
  }
  if (match.descriptor.id !== 'listPools' && match.descriptor.id !== 'listClosures') {
    return undefined;
  }
  return Object.freeze({
    generation,
    semanticEpoch,
    route: match.descriptor.id === 'listPools' ? 'pools' : 'closures',
    ...(filters === undefined ? {} : { filters }),
  });
}

type ParsedFilters =
  | Readonly<{ ok: true; filters?: ApiRepresentationFilters }>
  | Readonly<{ ok: false }>;

function parseFilters(searchParams: URLSearchParams, match: MatchedApiEndpoint): ParsedFilters {
  const supportsFilters = match.descriptor.id === 'listPools' ||
    match.descriptor.id === 'listClosures';
  if (!supportsFilters && searchParams.size > 0) {
    return Object.freeze({ ok: false });
  }

  const values: Record<string, string> = {};
  for (const [name, value] of searchParams) {
    const allowedValues = FILTERS[name as keyof typeof FILTERS] as ReadonlySet<string> | undefined;
    if (allowedValues === undefined || name in values || !allowedValues.has(value)) {
      return Object.freeze({ ok: false });
    }
    values[name] = value;
  }
  if (Object.keys(values).length === 0) {
    return Object.freeze({ ok: true });
  }
  return Object.freeze({
    ok: true,
    filters: Object.freeze({
      ...(values.locationType === undefined
        ? {}
        : { locationType: values.locationType as PoolLocationType }),
      ...(values.access === undefined ? {} : { access: values.access as PoolAccess }),
      ...(values.closureKind === undefined
        ? {}
        : { closureKind: values.closureKind as PoolClosureKind }),
      ...(values.dataState === undefined ? {} : { dataState: values.dataState as FreshnessState }),
    }),
  });
}

function problem(
  code: ApiProblemCode,
  instance: string,
  head: boolean,
  headers = new Headers(),
  retryAfterSeconds?: number,
  nextSourceAccessAt?: string,
): Response {
  return createProblemResponse({
    code,
    instance,
    head,
    headers,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(nextSourceAccessAt === undefined ? {} : { nextSourceAccessAt }),
  });
}

function optionsResponse(request: Request, corsHeaders: Headers): Response {
  const requestedHeaders = request.headers.get('access-control-request-headers');
  if (
    requestedHeaders !== null &&
    requestedHeaders.split(',').some((value) => !isAllowedRequestHeader(value.trim()))
  ) {
    return problem('invalid_request', '/', false, corsHeaders);
  }
  const headers = new Headers(corsHeaders);
  headers.set('allow', ALLOWED_METHODS);
  headers.set('access-control-allow-methods', ALLOWED_METHODS);
  headers.set('access-control-allow-headers', 'Accept, If-None-Match');
  headers.set('access-control-max-age', '600');
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 204, headers });
}

function jsonResponse(
  value: unknown,
  head: boolean,
  inputHeaders: Headers,
  cacheControl: string,
): Response {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const headers = new Headers(inputHeaders);
  headers.set('content-type', JSON_CONTENT_TYPE);
  headers.set('cache-control', cacheControl);
  headers.set('content-length', String(body.byteLength));
  return new Response(head ? null : body, { status: 200, headers });
}

function createCorsHeaders(origin: string | null, allowedOrigins: ReadonlySet<string>): Headers {
  const headers = new Headers();
  if (allowedOrigins.size > 0) {
    headers.set('vary', 'Origin');
  }
  if (origin !== null && allowedOrigins.has(origin)) {
    headers.set('access-control-allow-origin', origin);
  }
  return headers;
}

function acceptsJson(accept: string | null): boolean {
  if (accept === null || accept.trim() === '') {
    return true;
  }
  return accept.split(',').some((entry) => {
    const [mediaType, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const qualityValue = quality === undefined ? 1 : Number(quality.trim().slice(2));
    if (!Number.isFinite(qualityValue) || qualityValue <= 0 || qualityValue > 1) {
      return false;
    }
    return mediaType === '*/*' || mediaType === 'application/*' ||
      mediaType === 'application/json' || mediaType === 'application/problem+json';
  });
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.headers.get('content-length');
  return (contentLength !== null && contentLength !== '0') ||
    request.headers.has('transfer-encoding') || request.headers.has('content-type') ||
    request.body !== null;
}

function isRateLimitedEndpoint(match: MatchedApiEndpoint): boolean {
  return match.descriptor.id !== 'health' && match.descriptor.id !== 'readiness';
}

function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) {
    return false;
  }
  const normalizedEtag = etag.replace(/^W\//, '');
  return ifNoneMatch.split(',').some((value) => {
    const candidate = value.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === normalizedEtag;
  });
}

function publicCacheControl(
  projection: SemanticFreshnessProjection,
  nowEpochMs: number,
): string {
  const transitionSeconds = projection.nextTransitionAtEpochMs === undefined
    ? PUBLIC_CACHE_MAX_AGE_SECONDS
    : Math.max(0, Math.floor((projection.nextTransitionAtEpochMs - nowEpochMs) / 1_000));
  return `public, max-age=${Math.min(PUBLIC_CACHE_MAX_AGE_SECONDS, transitionSeconds)}`;
}

function semanticProjectionSignature(
  lastCheckedAt: string,
  projection: SemanticFreshnessProjection,
): string {
  return JSON.stringify({
    lastCheckedAt,
    snapshotState: projection.snapshotState,
    collectionState: projection.collectionState,
    nextSourceAccessAt: projection.nextSourceAccessAt,
    pools: projection.pools.map((pool) => ({
      id: pool.id,
      dataState: pool.dataState,
      operating: pool.operating.state,
      maintenance: pool.maintenance.state,
      attendance: pool.capacity.attendance.state,
      maximumCapacity: pool.capacity.maximumCapacity.state,
      remainingCapacity: pool.capacity.remainingCapacity.state,
      utilizationPercent: pool.capacity.utilizationPercent.state,
    })),
  });
}

function requestHeaderBytes(headers: Headers): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
  }
  return bytes;
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function isAllowedRequestHeader(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === 'accept' || normalized === 'if-none-match';
}
