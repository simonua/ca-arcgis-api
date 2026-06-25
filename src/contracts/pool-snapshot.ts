export const POOL_SNAPSHOT_SCHEMA_VERSION = '1.0.0' as const;

export const POOL_LOCATION_TYPES = Object.freeze(['indoor', 'outdoor'] as const);
export const POOL_ACCESS_VALUES = Object.freeze(
  [
    'open-public',
    'restricted-program',
    'partial',
    'closed',
    'unknown',
  ] as const,
);
export const POOL_ACTIVITY_VALUES = Object.freeze(
  [
    'rec-swim',
    'adult-laps',
    'swim-lessons',
    'aqua-fit',
    'senior-swim',
    'special-event',
    'none',
  ] as const,
);
export const POOL_CLOSURE_KINDS = Object.freeze(
  [
    'inclement-weather',
    'air-quality',
    'maintenance',
    'unplanned',
    'off-hours',
    'season',
    'swim-team',
    'summer-camp',
    'private-event',
    'none',
  ] as const,
);
export const POOL_AREAS = Object.freeze(['main-pool', 'baby-pool', 'program-pool'] as const);
export const POOL_MAINTENANCE_COMPONENTS = Object.freeze(
  [
    'wading-pool',
    'spa',
    'slide',
    'splashpad',
    'non-pool-amenities',
    'main-pool',
  ] as const,
);

export type PoolLocationType = (typeof POOL_LOCATION_TYPES)[number];
export type PoolAccess = (typeof POOL_ACCESS_VALUES)[number];
export type PoolActivity = (typeof POOL_ACTIVITY_VALUES)[number];
export type PoolClosureKind = (typeof POOL_CLOSURE_KINDS)[number];
export type PoolArea = (typeof POOL_AREAS)[number];
export type PoolMaintenanceComponent = (typeof POOL_MAINTENANCE_COMPONENTS)[number];

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
