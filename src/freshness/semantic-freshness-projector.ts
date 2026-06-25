import type {
  PoolCapacityState,
  PoolDatum,
  PoolMaintenanceComponent,
  PoolOperatingState,
  PoolSnapshot,
} from '../contracts/pool-snapshot.ts';
import type { OperatingWindowGate } from '../harvesting/operating-window-gate.ts';

export type FreshnessState = 'current' | 'degraded' | 'unavailable';
export type CollectionState = 'active' | 'paused-closed-hours';

export interface SemanticFreshnessPolicy {
  readonly snapshotCurrentMs: number;
  readonly snapshotMaxStaleMs: number;
  readonly attendanceCurrentMs: number;
  readonly statusCurrentMs: number;
  readonly statusMaxStaleMs: number;
}

export type SemanticFreshnessPolicyField = keyof SemanticFreshnessPolicy;

export type SemanticFreshnessConfigurationError = Readonly<{
  code: 'invalid-duration' | 'invalid-order';
  field: SemanticFreshnessPolicyField;
}>;

export interface ProjectedPoolRecord {
  readonly id: string;
  readonly displayName: string;
  readonly locationType: 'indoor' | 'outdoor';
  readonly webAppPoolId: string | null;
  readonly dataState: FreshnessState;
  readonly sourceReportedAt: string;
  readonly operating: PoolDatum<PoolOperatingState>;
  readonly maintenance: PoolDatum<readonly PoolMaintenanceComponent[]>;
  readonly capacity: PoolCapacityState;
  readonly nextTransitionAtEpochMs?: number;
}

export interface SemanticFreshnessProjection {
  readonly snapshotState: FreshnessState;
  readonly collectionState: CollectionState;
  readonly nextSourceAccessAt?: string;
  readonly pools: readonly ProjectedPoolRecord[];
  readonly nextTransitionAtEpochMs?: number;
}

export interface SemanticFreshnessProjector {
  project(
    snapshot: PoolSnapshot | undefined,
    nowEpochMs: number,
  ): SemanticFreshnessProjectionResult;
}

export type SemanticFreshnessProjectorResult =
  | Readonly<{ ok: true; projector: SemanticFreshnessProjector }>
  | Readonly<{ ok: false; error: SemanticFreshnessConfigurationError }>;

export type SemanticFreshnessProjectionResult =
  | Readonly<{ ok: true; value: SemanticFreshnessProjection }>
  | Readonly<{ ok: false; error: Readonly<{ code: 'invalid-time' }> }>;

const UNAVAILABLE_NUMBER: PoolDatum<number> = Object.freeze({ state: 'unavailable' });
const UNAVAILABLE_OPERATING: PoolDatum<PoolOperatingState> = Object.freeze({
  state: 'unavailable',
});
const UNAVAILABLE_MAINTENANCE: PoolDatum<readonly PoolMaintenanceComponent[]> = Object.freeze({
  state: 'unavailable',
});
const UNAVAILABLE_CAPACITY: PoolCapacityState = Object.freeze({
  attendance: UNAVAILABLE_NUMBER,
  maximumCapacity: UNAVAILABLE_NUMBER,
  remainingCapacity: UNAVAILABLE_NUMBER,
  utilizationPercent: UNAVAILABLE_NUMBER,
});

/** Creates a pure projection boundary over retained snapshots and an injected operating window. */
export function createSemanticFreshnessProjector(
  policy: SemanticFreshnessPolicy,
  operatingWindowGate: OperatingWindowGate,
): SemanticFreshnessProjectorResult {
  const policyError = validatePolicy(policy);
  if (policyError !== undefined) {
    return Object.freeze({ ok: false, error: policyError });
  }

  const immutablePolicy = Object.freeze({ ...policy });
  return Object.freeze({
    ok: true,
    projector: Object.freeze({
      project(
        snapshot: PoolSnapshot | undefined,
        nowEpochMs: number,
      ): SemanticFreshnessProjectionResult {
        if (!isEpochMs(nowEpochMs)) {
          return Object.freeze({
            ok: false,
            error: Object.freeze({ code: 'invalid-time' as const }),
          });
        }

        const windowDecision = operatingWindowGate.evaluate(nowEpochMs);
        if (!windowDecision.allowed && windowDecision.reason === 'invalid-time') {
          return Object.freeze({
            ok: false,
            error: Object.freeze({ code: 'invalid-time' as const }),
          });
        }

        const collection: Readonly<{
          state: CollectionState;
          transitionAtEpochMs?: number;
          nextSourceAccessAt?: string;
        }> = windowDecision.allowed
          ? Object.freeze({
            state: 'active' as const,
            transitionAtEpochMs: windowDecision.closesAtEpochMs,
          })
          : Object.freeze({
            state: 'paused-closed-hours' as const,
            ...(windowDecision.nextOpensAtEpochMs === undefined ? {} : {
              transitionAtEpochMs: windowDecision.nextOpensAtEpochMs,
              nextSourceAccessAt: new Date(windowDecision.nextOpensAtEpochMs).toISOString(),
            }),
          });

        const checkedAtEpochMs = snapshot === undefined
          ? undefined
          : parseIsoInstant(snapshot.lastCheckedAt);
        const snapshotFreshness = freshnessAt(
          checkedAtEpochMs,
          nowEpochMs,
          immutablePolicy.snapshotCurrentMs,
          immutablePolicy.snapshotMaxStaleMs,
        );

        const pools = snapshot === undefined
          ? Object.freeze([])
          : Object.freeze(snapshot.pools.map((pool) => {
            const reportedAtEpochMs = parseIsoInstant(pool.sourceReportedAt);
            const statusFreshness = freshnessAt(
              reportedAtEpochMs,
              nowEpochMs,
              immutablePolicy.statusCurrentMs,
              immutablePolicy.statusMaxStaleMs,
            );
            const dataState = worseState(snapshotFreshness.state, statusFreshness.state);
            const serviceable = dataState !== 'unavailable';
            const attendanceTransition =
              serviceable && pool.capacity.attendance.state === 'available'
                ? currentOnlyTransition(
                  reportedAtEpochMs,
                  nowEpochMs,
                  immutablePolicy.attendanceCurrentMs,
                )
                : undefined;
            const attendanceAvailable = attendanceTransition?.state === 'current';
            const nextTransitionAtEpochMs = earliest(
              dataStateTransition(snapshotFreshness, statusFreshness, dataState),
              attendanceTransition?.nextTransitionAtEpochMs,
            );

            return Object.freeze({
              id: pool.id,
              displayName: pool.displayName,
              locationType: pool.locationType,
              webAppPoolId: pool.webAppPoolId,
              dataState,
              sourceReportedAt: pool.sourceReportedAt,
              operating: serviceable
                ? Object.freeze({ state: 'available' as const, value: pool.operating })
                : UNAVAILABLE_OPERATING,
              maintenance: serviceable ? pool.maintenance : UNAVAILABLE_MAINTENANCE,
              capacity: serviceable
                ? projectCapacity(pool.capacity, attendanceAvailable)
                : UNAVAILABLE_CAPACITY,
              ...(nextTransitionAtEpochMs === undefined ? {} : { nextTransitionAtEpochMs }),
            });
          }));

        const poolTransitionAtEpochMs = earliest(
          ...pools.map((pool) => pool.nextTransitionAtEpochMs),
        );
        const nextTransitionAtEpochMs = earliest(
          collection.transitionAtEpochMs,
          snapshotFreshness.nextTransitionAtEpochMs,
          poolTransitionAtEpochMs,
        );

        return Object.freeze({
          ok: true,
          value: Object.freeze({
            snapshotState: snapshotFreshness.state,
            collectionState: collection.state,
            ...(collection.nextSourceAccessAt === undefined
              ? {}
              : { nextSourceAccessAt: collection.nextSourceAccessAt }),
            pools,
            ...(nextTransitionAtEpochMs === undefined ? {} : { nextTransitionAtEpochMs }),
          }),
        });
      },
    }),
  });
}

function validatePolicy(
  policy: SemanticFreshnessPolicy,
): SemanticFreshnessConfigurationError | undefined {
  for (const field of Object.keys(policy) as SemanticFreshnessPolicyField[]) {
    if (!isPositiveDuration(policy[field])) {
      return Object.freeze({ code: 'invalid-duration', field });
    }
  }
  if (policy.snapshotCurrentMs >= policy.snapshotMaxStaleMs) {
    return Object.freeze({ code: 'invalid-order', field: 'snapshotMaxStaleMs' });
  }
  if (policy.attendanceCurrentMs >= policy.statusCurrentMs) {
    return Object.freeze({ code: 'invalid-order', field: 'attendanceCurrentMs' });
  }
  if (policy.statusCurrentMs >= policy.statusMaxStaleMs) {
    return Object.freeze({ code: 'invalid-order', field: 'statusMaxStaleMs' });
  }
  return undefined;
}

function freshnessAt(
  instantEpochMs: number | undefined,
  nowEpochMs: number,
  currentMs: number,
  maxStaleMs: number,
): Readonly<{ state: FreshnessState; nextTransitionAtEpochMs?: number }> {
  if (instantEpochMs === undefined || instantEpochMs > nowEpochMs) {
    return Object.freeze({ state: 'unavailable' });
  }

  const ageMs = nowEpochMs - instantEpochMs;
  if (ageMs <= currentMs) {
    return withTransition('current', afterDuration(instantEpochMs, currentMs));
  }
  if (ageMs <= maxStaleMs) {
    return withTransition('degraded', afterDuration(instantEpochMs, maxStaleMs));
  }
  return Object.freeze({ state: 'unavailable' });
}

function currentOnlyTransition(
  instantEpochMs: number | undefined,
  nowEpochMs: number,
  currentMs: number,
): Readonly<{ state: 'current' | 'unavailable'; nextTransitionAtEpochMs?: number }> {
  if (instantEpochMs === undefined || instantEpochMs > nowEpochMs) {
    return Object.freeze({ state: 'unavailable' });
  }
  if (nowEpochMs - instantEpochMs <= currentMs) {
    return withTransition('current', afterDuration(instantEpochMs, currentMs));
  }
  return Object.freeze({ state: 'unavailable' });
}

function projectCapacity(
  capacity: PoolCapacityState,
  attendanceAvailable: boolean,
): PoolCapacityState {
  return Object.freeze({
    attendance: attendanceAvailable ? capacity.attendance : UNAVAILABLE_NUMBER,
    maximumCapacity: capacity.maximumCapacity,
    remainingCapacity: attendanceAvailable ? capacity.remainingCapacity : UNAVAILABLE_NUMBER,
    utilizationPercent: attendanceAvailable ? capacity.utilizationPercent : UNAVAILABLE_NUMBER,
  });
}

function worseState(left: FreshnessState, right: FreshnessState): FreshnessState {
  if (left === 'unavailable' || right === 'unavailable') {
    return 'unavailable';
  }
  return left === 'degraded' || right === 'degraded' ? 'degraded' : 'current';
}

function dataStateTransition(
  snapshotFreshness: Readonly<{
    state: FreshnessState;
    nextTransitionAtEpochMs?: number;
  }>,
  statusFreshness: Readonly<{
    state: FreshnessState;
    nextTransitionAtEpochMs?: number;
  }>,
  dataState: FreshnessState,
): number | undefined {
  if (dataState === 'current') {
    return earliest(
      snapshotFreshness.nextTransitionAtEpochMs,
      statusFreshness.nextTransitionAtEpochMs,
    );
  }
  if (dataState === 'degraded') {
    return earliest(
      snapshotFreshness.state === 'degraded'
        ? snapshotFreshness.nextTransitionAtEpochMs
        : undefined,
      statusFreshness.state === 'degraded' ? statusFreshness.nextTransitionAtEpochMs : undefined,
    );
  }
  return undefined;
}

function withTransition<T extends FreshnessState>(
  state: T,
  nextTransitionAtEpochMs: number | undefined,
): Readonly<{ state: T; nextTransitionAtEpochMs?: number }> {
  return Object.freeze({
    state,
    ...(nextTransitionAtEpochMs === undefined ? {} : { nextTransitionAtEpochMs }),
  });
}

function afterDuration(instantEpochMs: number, durationMs: number): number | undefined {
  const transitionAtEpochMs = instantEpochMs + durationMs + 1;
  return isEpochMs(transitionAtEpochMs) ? transitionAtEpochMs : undefined;
}

function earliest(...values: readonly (number | undefined)[]): number | undefined {
  let earliestValue: number | undefined;
  for (const value of values) {
    if (value !== undefined && (earliestValue === undefined || value < earliestValue)) {
      earliestValue = value;
    }
  }
  return earliestValue;
}

function parseIsoInstant(value: string): number | undefined {
  const epochMs = Date.parse(value);
  if (!isEpochMs(epochMs) || new Date(epochMs).toISOString() !== value) {
    return undefined;
  }
  return epochMs;
}

function isPositiveDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
