export const POOL_SNAPSHOT_SCHEMA_VERSION = '1.0.0' as const;

export type PoolLocationType = 'indoor' | 'outdoor';

export type PoolAccess =
  | 'open-public'
  | 'restricted-program'
  | 'partial'
  | 'closed'
  | 'unknown';

export type PoolActivity =
  | 'rec-swim'
  | 'adult-laps'
  | 'swim-lessons'
  | 'aqua-fit'
  | 'senior-swim'
  | 'special-event'
  | 'none';

export type PoolClosureKind =
  | 'inclement-weather'
  | 'air-quality'
  | 'maintenance'
  | 'unplanned'
  | 'off-hours'
  | 'season'
  | 'swim-team'
  | 'summer-camp'
  | 'private-event'
  | 'none';

export type PoolArea = 'main-pool' | 'baby-pool' | 'program-pool';

export type PoolMaintenanceComponent =
  | 'wading-pool'
  | 'spa'
  | 'slide'
  | 'splashpad'
  | 'non-pool-amenities'
  | 'main-pool';

export type PoolDatum<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{ state: 'unavailable' }>;

export interface PoolOperatingState {
  readonly access: PoolAccess;
  readonly activity: PoolActivity;
  readonly closureKind: PoolClosureKind;
  readonly availableAreas: readonly PoolArea[];
}

export interface PoolCapacityState {
  readonly attendance: PoolDatum<number>;
  readonly maximumCapacity: PoolDatum<number>;
  readonly remainingCapacity: PoolDatum<number>;
  readonly utilizationPercent: PoolDatum<number>;
}

/** Consumer-owned pool state. No ArcGIS field names or source presentation values are retained. */
export interface PoolSnapshotRecord {
  readonly id: string;
  readonly displayName: string;
  readonly locationType: PoolLocationType;
  readonly webAppPoolId: string | null;
  readonly operating: PoolOperatingState;
  readonly maintenance: PoolDatum<readonly PoolMaintenanceComponent[]>;
  readonly capacity: PoolCapacityState;
  readonly sourceReportedAt: string;
}

export interface PoolSnapshotCandidate {
  readonly pools: readonly PoolSnapshotRecord[];
}

export interface PoolSnapshot extends PoolSnapshotCandidate {
  readonly schemaVersion: typeof POOL_SNAPSHOT_SCHEMA_VERSION;
  readonly generation: number;
  readonly lastCheckedAt: string;
}
