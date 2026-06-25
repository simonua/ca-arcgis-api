import type { ApiRepresentationFilters } from '../cache/api-representation-cache.ts';
import type { PoolDatum, PoolSnapshot } from '../contracts/pool-snapshot.ts';
import type {
  ProjectedPoolRecord,
  SemanticFreshnessProjection,
} from '../freshness/semantic-freshness-projector.ts';
import { API_VERSION } from './endpoint-descriptors.ts';

export interface ApiSnapshotRepresentation {
  readonly lastCheckedAt: string;
  readonly state: SemanticFreshnessProjection['snapshotState'];
  readonly collectionState: SemanticFreshnessProjection['collectionState'];
  readonly nextSourceAccessAt?: string;
}

export interface ApiPoolRepresentation {
  readonly id: string;
  readonly webAppPoolId: string | null;
  readonly name: string;
  readonly locationType: ProjectedPoolRecord['locationType'];
  readonly dataState: ProjectedPoolRecord['dataState'];
  readonly reportedAt: string;
  readonly operating:
    | null
    | Readonly<{
      access: string;
      activity: string;
      closureKind: string;
      availableAreas: readonly string[];
    }>;
  readonly maintenance: null | Readonly<{ affectedComponents: readonly string[] }>;
  readonly occupancy: Readonly<{
    attendance: number | null;
    maximumCapacity: number | null;
    remainingCapacity: number | null;
    utilizationPercent: number | null;
  }>;
}

/** Builds an immutable, normalized collection representation. */
export function createPoolsRepresentation(
  snapshot: PoolSnapshot,
  projection: SemanticFreshnessProjection,
  filters: ApiRepresentationFilters | undefined,
): Readonly<Record<string, unknown>> {
  const pools = projection.pools.filter((pool) => matchesFilters(pool, filters)).map(toApiPool);
  return Object.freeze({
    apiVersion: API_VERSION,
    snapshot: toApiSnapshot(snapshot, projection),
    pools: Object.freeze(pools),
  });
}

/** Builds one normalized pool representation. */
export function createPoolRepresentation(
  snapshot: PoolSnapshot,
  projection: SemanticFreshnessProjection,
  poolId: string,
): Readonly<Record<string, unknown>> | undefined {
  const pool = projection.pools.find((candidate) => candidate.id === poolId);
  return pool === undefined ? undefined : Object.freeze({
    apiVersion: API_VERSION,
    snapshot: toApiSnapshot(snapshot, projection),
    pool: toApiPool(pool),
  });
}

/** Builds the operational closure subset without inferring unavailable status. */
export function createClosuresRepresentation(
  snapshot: PoolSnapshot,
  projection: SemanticFreshnessProjection,
  filters: ApiRepresentationFilters | undefined,
): Readonly<Record<string, unknown>> {
  const closures = projection.pools.filter(isClosure).filter((pool) =>
    matchesFilters(pool, filters)
  )
    .map(toApiPool);
  return Object.freeze({
    apiVersion: API_VERSION,
    snapshot: toApiSnapshot(snapshot, projection),
    closures: Object.freeze(closures),
  });
}

export function hasServiceableSnapshot(
  snapshot: PoolSnapshot | undefined,
  projection: SemanticFreshnessProjection,
): boolean {
  return snapshot !== undefined && projection.snapshotState !== 'unavailable' &&
    projection.pools.some((pool) => pool.dataState !== 'unavailable');
}

function toApiSnapshot(
  snapshot: PoolSnapshot,
  projection: SemanticFreshnessProjection,
): ApiSnapshotRepresentation {
  return Object.freeze({
    lastCheckedAt: snapshot.lastCheckedAt,
    state: projection.snapshotState,
    collectionState: projection.collectionState,
    ...(projection.nextSourceAccessAt === undefined
      ? {}
      : { nextSourceAccessAt: projection.nextSourceAccessAt }),
  });
}

function toApiPool(pool: ProjectedPoolRecord): ApiPoolRepresentation {
  return Object.freeze({
    id: pool.id,
    webAppPoolId: pool.webAppPoolId,
    name: pool.displayName,
    locationType: pool.locationType,
    dataState: pool.dataState,
    reportedAt: pool.sourceReportedAt,
    operating: pool.operating.state === 'available'
      ? Object.freeze({
        access: pool.operating.value.access,
        activity: pool.operating.value.activity,
        closureKind: pool.operating.value.closureKind,
        availableAreas: Object.freeze([...pool.operating.value.availableAreas]),
      })
      : null,
    maintenance: pool.maintenance.state === 'available'
      ? Object.freeze({ affectedComponents: Object.freeze([...pool.maintenance.value]) })
      : null,
    occupancy: Object.freeze({
      attendance: datumValue(pool.capacity.attendance),
      maximumCapacity: datumValue(pool.capacity.maximumCapacity),
      remainingCapacity: datumValue(pool.capacity.remainingCapacity),
      utilizationPercent: datumValue(pool.capacity.utilizationPercent),
    }),
  });
}

function matchesFilters(
  pool: ProjectedPoolRecord,
  filters: ApiRepresentationFilters | undefined,
): boolean {
  if (filters === undefined) {
    return true;
  }
  if (filters.locationType !== undefined && pool.locationType !== filters.locationType) {
    return false;
  }
  if (filters.dataState !== undefined && pool.dataState !== filters.dataState) {
    return false;
  }
  if (
    filters.access !== undefined &&
    (pool.operating.state !== 'available' || pool.operating.value.access !== filters.access)
  ) {
    return false;
  }
  if (
    filters.closureKind !== undefined &&
    (pool.operating.state !== 'available' ||
      pool.operating.value.closureKind !== filters.closureKind)
  ) {
    return false;
  }
  return true;
}

function isClosure(pool: ProjectedPoolRecord): boolean {
  return pool.operating.state === 'available' && pool.operating.value.closureKind !== 'none';
}

function datumValue(datum: PoolDatum<number>): number | null {
  return datum.state === 'available' ? datum.value : null;
}
