import { isPoolApiId } from '../contracts/pool-identity.ts';
import {
  POOL_ACCESS_VALUES,
  POOL_CLOSURE_KINDS,
  POOL_LOCATION_TYPES,
  type PoolAccess,
  type PoolClosureKind,
  type PoolLocationType,
} from '../contracts/pool-snapshot.ts';
import type { FreshnessState } from '../freshness/semantic-freshness-projector.ts';

export type ApiRepresentationRoute = 'pools' | 'pool' | 'closures';

export interface ApiRepresentationFilters {
  readonly locationType?: PoolLocationType;
  readonly access?: PoolAccess;
  readonly closureKind?: PoolClosureKind;
  readonly dataState?: FreshnessState;
}

export const API_REPRESENTATION_FILTER_VALUES = Object.freeze({
  locationType: POOL_LOCATION_TYPES,
  access: POOL_ACCESS_VALUES,
  closureKind: POOL_CLOSURE_KINDS,
  dataState: Object.freeze(
    [
      'current',
      'degraded',
      'unavailable',
    ] satisfies readonly FreshnessState[],
  ),
});

interface ApiRepresentationKeyBase {
  readonly generation: number;
  readonly semanticEpoch: number;
}

export type ApiRepresentationKey =
  | Readonly<
    ApiRepresentationKeyBase & {
      route: 'pools' | 'closures';
      filters?: ApiRepresentationFilters;
    }
  >
  | Readonly<
    ApiRepresentationKeyBase & {
      route: 'pool';
      poolId: string;
    }
  >;

export type ApiRepresentationInvalidationScope =
  | Readonly<{ route: 'pools' | 'closures' }>
  | Readonly<{ route: 'pool'; poolId: string }>;

export interface ApiRepresentation {
  readonly body: Uint8Array;
  readonly byteLength: number;
  readonly etag: string;
}

export type ApiRepresentationCacheReadStatus = 'hit' | 'miss' | 'coalesced';

export type ApiRepresentationCacheReadResult =
  | Readonly<{
    ok: true;
    status: ApiRepresentationCacheReadStatus;
    representation: ApiRepresentation;
  }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code:
        | 'factory-failed'
        | 'inactive-generation'
        | 'etag-failed'
        | 'invalid-key'
        | 'representation-too-large'
        | 'serialization-failed';
    }>;
  }>;

export type ApiRepresentationCacheMutationResult =
  | Readonly<{ ok: true; removedEntries: number }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code: 'invalid-generation' | 'invalid-scope' | 'stale-generation';
    }>;
  }>;

export interface ApiRepresentationCacheStats {
  readonly activeGeneration?: number;
  readonly entries: number;
  readonly bytes: number;
  readonly inFlight: number;
}

export interface ApiRepresentationCache {
  activateGeneration(generation: number): ApiRepresentationCacheMutationResult;
  getOrCreate(
    key: unknown,
    factory: () => unknown | Promise<unknown>,
  ): Promise<ApiRepresentationCacheReadResult>;
  invalidate(
    scopes: readonly ApiRepresentationInvalidationScope[],
  ): ApiRepresentationCacheMutationResult;
  stats(): ApiRepresentationCacheStats;
}

export type ApiRepresentationCacheCreationResult =
  | Readonly<{ ok: true; cache: ApiRepresentationCache }>
  | Readonly<{
    ok: false;
    error: Readonly<{ code: 'invalid-max-bytes' | 'invalid-max-entries' }>;
  }>;

export interface ApiRepresentationCacheOptions {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

interface StoredRepresentation {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly byteLength: number;
  readonly key: ApiRepresentationKey;
  readonly scopeToken: string;
}

type StoredRepresentationResult =
  | Readonly<{ ok: true; value: StoredRepresentation }>
  | Extract<ApiRepresentationCacheReadResult, { ok: false }>;

const LOCATION_TYPES: ReadonlySet<string> = new Set(
  API_REPRESENTATION_FILTER_VALUES.locationType,
);
const ACCESS_VALUES: ReadonlySet<string> = new Set(API_REPRESENTATION_FILTER_VALUES.access);
const CLOSURE_KINDS: ReadonlySet<string> = new Set(
  API_REPRESENTATION_FILTER_VALUES.closureKind,
);
const FRESHNESS_STATES: ReadonlySet<string> = new Set(
  API_REPRESENTATION_FILTER_VALUES.dataState,
);
const FILTER_NAMES = new Set(['locationType', 'access', 'closureKind', 'dataState']);

/** Stores only bounded, successful API representations for one active snapshot generation. */
export function createApiRepresentationCache(
  options: ApiRepresentationCacheOptions,
): ApiRepresentationCacheCreationResult {
  if (!isPositiveSafeInteger(options.maxEntries)) {
    return creationFailure('invalid-max-entries');
  }
  if (!isPositiveSafeInteger(options.maxBytes)) {
    return creationFailure('invalid-max-bytes');
  }

  const entries = new Map<string, StoredRepresentation>();
  const inFlight = new Map<string, Promise<StoredRepresentationResult>>();
  const scopeRevisions = new Map<string, number>();
  let activeGeneration: number | undefined;
  let totalBytes = 0;

  const cache: ApiRepresentationCache = Object.freeze({
    activateGeneration(generation: number): ApiRepresentationCacheMutationResult {
      if (!isPositiveSafeInteger(generation)) {
        return mutationFailure('invalid-generation');
      }
      if (activeGeneration !== undefined && generation < activeGeneration) {
        return mutationFailure('stale-generation');
      }
      if (generation === activeGeneration) {
        return Object.freeze({ ok: true, removedEntries: 0 });
      }

      const removedEntries = entries.size;
      entries.clear();
      totalBytes = 0;
      activeGeneration = generation;
      return Object.freeze({ ok: true, removedEntries });
    },

    async getOrCreate(
      input: unknown,
      factory: () => unknown | Promise<unknown>,
    ): Promise<ApiRepresentationCacheReadResult> {
      const key = copyValidKey(input);
      if (key === undefined) {
        return readFailure('invalid-key');
      }
      if (key.generation !== activeGeneration) {
        return readFailure('inactive-generation');
      }

      const cacheKey = canonicalKey(key);
      const cached = entries.get(cacheKey);
      if (cached !== undefined) {
        entries.delete(cacheKey);
        entries.set(cacheKey, cached);
        return readSuccess(cached, 'hit');
      }

      const pending = inFlight.get(cacheKey);
      if (pending !== undefined) {
        return materialize(await pending, 'coalesced');
      }

      const scopeToken = scopeTokenFromKey(key);
      const startingScopeRevision = scopeRevisions.get(scopeToken) ?? 0;
      const fill = buildRepresentation(key, scopeToken, factory, options.maxBytes);
      inFlight.set(cacheKey, fill);
      try {
        const result = await fill;
        if (
          result.ok && key.generation === activeGeneration &&
          (scopeRevisions.get(scopeToken) ?? 0) === startingScopeRevision
        ) {
          insert(result.value);
        }
        return materialize(result, 'miss');
      } finally {
        inFlight.delete(cacheKey);
      }
    },

    invalidate(
      scopes: readonly ApiRepresentationInvalidationScope[],
    ): ApiRepresentationCacheMutationResult {
      if (scopes.length === 0 || scopes.some((scope) => !isValidScope(scope))) {
        return mutationFailure('invalid-scope');
      }

      const scopeTokens = new Set(scopes.map(scopeTokenFromScope));
      for (const scopeToken of scopeTokens) {
        scopeRevisions.set(scopeToken, (scopeRevisions.get(scopeToken) ?? 0) + 1);
      }

      let removedEntries = 0;
      for (const [cacheKey, entry] of entries) {
        if (scopeTokens.has(entry.scopeToken)) {
          entries.delete(cacheKey);
          totalBytes -= entry.byteLength;
          removedEntries += 1;
        }
      }
      return Object.freeze({ ok: true, removedEntries });
    },

    stats(): ApiRepresentationCacheStats {
      return Object.freeze({
        ...(activeGeneration === undefined ? {} : { activeGeneration }),
        entries: entries.size,
        bytes: totalBytes,
        inFlight: inFlight.size,
      });
    },
  });

  function insert(entry: StoredRepresentation): void {
    const cacheKey = canonicalKey(entry.key);
    const existing = entries.get(cacheKey);
    if (existing !== undefined) {
      totalBytes -= existing.byteLength;
      entries.delete(cacheKey);
    }
    entries.set(cacheKey, entry);
    totalBytes += entry.byteLength;

    while (entries.size > options.maxEntries || totalBytes > options.maxBytes) {
      const leastRecentlyUsedKey = entries.keys().next().value;
      if (leastRecentlyUsedKey === undefined) {
        break;
      }
      const evicted = entries.get(leastRecentlyUsedKey);
      entries.delete(leastRecentlyUsedKey);
      if (evicted !== undefined) {
        totalBytes -= evicted.byteLength;
      }
    }
  }

  return Object.freeze({ ok: true, cache });
}

async function buildRepresentation(
  key: ApiRepresentationKey,
  scopeToken: string,
  factory: () => unknown | Promise<unknown>,
  maxBytes: number,
): Promise<StoredRepresentationResult> {
  let value: unknown;
  try {
    value = await factory();
  } catch {
    return readFailure('factory-failed');
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return readFailure('serialization-failed');
  }
  if (serialized === undefined) {
    return readFailure('serialization-failed');
  }

  const body = new TextEncoder().encode(serialized);
  if (body.byteLength > maxBytes) {
    return readFailure('representation-too-large');
  }

  let digest: Uint8Array;
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  } catch {
    return readFailure('etag-failed');
  }
  const etag = `"sha256-${toHex(digest)}"`;
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      body,
      byteLength: body.byteLength,
      etag,
      key,
      scopeToken,
    }),
  });
}

function isValidKey(key: unknown): key is ApiRepresentationKey {
  if (!isRecord(key) || !isPositiveSafeInteger(key.generation) || !isEpoch(key.semanticEpoch)) {
    return false;
  }
  if (key.route === 'pool') {
    return hasOnlyKeys(key, ['generation', 'semanticEpoch', 'route', 'poolId']) &&
      isPoolApiId(key.poolId);
  }
  if (key.route !== 'pools' && key.route !== 'closures') {
    return false;
  }
  if (!hasOnlyKeys(key, ['generation', 'semanticEpoch', 'route', 'filters'])) {
    return false;
  }
  return key.filters === undefined || isValidFilters(key.filters);
}

function copyValidKey(input: unknown): ApiRepresentationKey | undefined {
  try {
    if (!isValidKey(input)) {
      return undefined;
    }
    const copy: ApiRepresentationKey = input.route === 'pool'
      ? Object.freeze({
        generation: input.generation,
        semanticEpoch: input.semanticEpoch,
        route: input.route,
        poolId: input.poolId,
      })
      : Object.freeze({
        generation: input.generation,
        semanticEpoch: input.semanticEpoch,
        route: input.route,
        ...(input.filters === undefined ? {} : { filters: Object.freeze({ ...input.filters }) }),
      });
    return isValidKey(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

function isValidFilters(filters: unknown): boolean {
  if (!isRecord(filters)) {
    return false;
  }
  const names = Object.keys(filters);
  if (names.length === 0 || names.some((name) => !FILTER_NAMES.has(name))) {
    return false;
  }
  return isAllowedOptionalString(filters, 'locationType', LOCATION_TYPES) &&
    isAllowedOptionalString(filters, 'access', ACCESS_VALUES) &&
    isAllowedOptionalString(filters, 'closureKind', CLOSURE_KINDS) &&
    isAllowedOptionalString(filters, 'dataState', FRESHNESS_STATES);
}

function isAllowedOptionalString(
  value: Record<string, unknown>,
  property: string,
  allowed: ReadonlySet<string>,
): boolean {
  if (!Object.hasOwn(value, property)) {
    return true;
  }
  const candidate = value[property];
  return typeof candidate === 'string' && allowed.has(candidate);
}

function isValidScope(scope: ApiRepresentationInvalidationScope): boolean {
  if (!isRecord(scope)) {
    return false;
  }
  if (scope.route === 'pool') {
    return hasOnlyKeys(scope, ['route', 'poolId']) && isPoolApiId(scope.poolId);
  }
  return (scope.route === 'pools' || scope.route === 'closures') &&
    hasOnlyKeys(scope, ['route']);
}

function canonicalKey(key: ApiRepresentationKey): string {
  if (key.route === 'pool') {
    return JSON.stringify([key.generation, key.semanticEpoch, key.route, key.poolId]);
  }
  return JSON.stringify([
    key.generation,
    key.semanticEpoch,
    key.route,
    key.filters?.locationType ?? null,
    key.filters?.access ?? null,
    key.filters?.closureKind ?? null,
    key.filters?.dataState ?? null,
  ]);
}

function scopeTokenFromKey(key: ApiRepresentationKey): string {
  return key.route === 'pool' ? `pool:${key.poolId}` : key.route;
}

function scopeTokenFromScope(scope: ApiRepresentationInvalidationScope): string {
  return scope.route === 'pool' ? `pool:${scope.poolId}` : scope.route;
}

function materialize(
  result: StoredRepresentationResult,
  status: ApiRepresentationCacheReadStatus,
): ApiRepresentationCacheReadResult {
  return result.ok ? readSuccess(result.value, status) : result;
}

function readSuccess(
  stored: StoredRepresentation,
  status: ApiRepresentationCacheReadStatus,
): ApiRepresentationCacheReadResult {
  return Object.freeze({
    ok: true,
    status,
    representation: Object.freeze({
      body: stored.body.slice(),
      byteLength: stored.byteLength,
      etag: stored.etag,
    }),
  });
}

function readFailure(
  code: Extract<ApiRepresentationCacheReadResult, { ok: false }>['error']['code'],
): Extract<ApiRepresentationCacheReadResult, { ok: false }> {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function creationFailure(
  code: Extract<ApiRepresentationCacheCreationResult, { ok: false }>['error']['code'],
): Extract<ApiRepresentationCacheCreationResult, { ok: false }> {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function mutationFailure(
  code: Extract<ApiRepresentationCacheMutationResult, { ok: false }>['error']['code'],
): Extract<ApiRepresentationCacheMutationResult, { ok: false }> {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
