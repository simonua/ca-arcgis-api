import {
  POOL_SNAPSHOT_SCHEMA_VERSION,
  type PoolDatum,
  type PoolMaintenanceComponent,
  type PoolSnapshot,
  type PoolSnapshotCandidate,
  type PoolSnapshotRecord,
} from '../contracts/pool-snapshot.ts';

export type SnapshotStoreErrorCode = 'invalid-checked-at' | 'no-snapshot';

export type SnapshotStoreResult =
  | Readonly<{ ok: true; snapshot: PoolSnapshot }>
  | Readonly<{ ok: false; error: Readonly<{ code: SnapshotStoreErrorCode }> }>;

export interface SnapshotStore {
  current(): PoolSnapshot | undefined;
  publish(candidate: PoolSnapshotCandidate, checkedAtEpochMs: number): SnapshotStoreResult;
  refresh(checkedAtEpochMs: number): SnapshotStoreResult;
}

/** Holds one immutable snapshot reference and replaces it only after complete candidate creation. */
export function createSnapshotStore(): SnapshotStore {
  let currentSnapshot: PoolSnapshot | undefined;
  let generation = 0;

  return Object.freeze({
    current(): PoolSnapshot | undefined {
      return currentSnapshot;
    },

    publish(candidate: PoolSnapshotCandidate, checkedAtEpochMs: number): SnapshotStoreResult {
      const lastCheckedAt = toIsoInstant(checkedAtEpochMs);
      if (lastCheckedAt === undefined) {
        return failure('invalid-checked-at');
      }
      const nextGeneration = generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        return failure('invalid-checked-at');
      }
      const nextSnapshot = Object.freeze({
        schemaVersion: POOL_SNAPSHOT_SCHEMA_VERSION,
        generation: nextGeneration,
        lastCheckedAt,
        pools: freezePools(candidate.pools),
      });
      generation = nextGeneration;
      currentSnapshot = nextSnapshot;
      return Object.freeze({ ok: true, snapshot: nextSnapshot });
    },

    refresh(checkedAtEpochMs: number): SnapshotStoreResult {
      if (currentSnapshot === undefined) {
        return failure('no-snapshot');
      }
      const lastCheckedAt = toIsoInstant(checkedAtEpochMs);
      if (lastCheckedAt === undefined) {
        return failure('invalid-checked-at');
      }
      currentSnapshot = Object.freeze({
        ...currentSnapshot,
        lastCheckedAt,
      });
      return Object.freeze({ ok: true, snapshot: currentSnapshot });
    },
  });
}

function freezePools(pools: readonly PoolSnapshotRecord[]): readonly PoolSnapshotRecord[] {
  return Object.freeze(pools.map((pool) =>
    Object.freeze({
      id: pool.id,
      displayName: pool.displayName,
      locationType: pool.locationType,
      webAppPoolId: pool.webAppPoolId,
      operating: Object.freeze({
        access: pool.operating.access,
        activity: pool.operating.activity,
        closureKind: pool.operating.closureKind,
        availableAreas: Object.freeze([...pool.operating.availableAreas]),
      }),
      maintenance: freezeMaintenance(pool.maintenance),
      capacity: Object.freeze({
        attendance: freezeDatum(pool.capacity.attendance),
        maximumCapacity: freezeDatum(pool.capacity.maximumCapacity),
        remainingCapacity: freezeDatum(pool.capacity.remainingCapacity),
        utilizationPercent: freezeDatum(pool.capacity.utilizationPercent),
      }),
      sourceReportedAt: pool.sourceReportedAt,
    })
  ));
}

function freezeMaintenance(
  maintenance: PoolDatum<readonly PoolMaintenanceComponent[]>,
): PoolDatum<readonly PoolMaintenanceComponent[]> {
  return maintenance.state === 'available'
    ? Object.freeze({ state: 'available', value: Object.freeze([...maintenance.value]) })
    : Object.freeze({ state: 'unavailable' });
}

function freezeDatum<T>(datum: PoolDatum<T>): PoolDatum<T> {
  return datum.state === 'available'
    ? Object.freeze({ state: 'available', value: datum.value })
    : Object.freeze({ state: 'unavailable' });
}

function toIsoInstant(epochMs: number): string | undefined {
  return Number.isSafeInteger(epochMs) && epochMs >= 0
    ? new Date(epochMs).toISOString()
    : undefined;
}

function failure(code: SnapshotStoreErrorCode): SnapshotStoreResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}
