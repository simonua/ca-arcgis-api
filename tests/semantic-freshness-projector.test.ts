import type { PoolSnapshot } from '../src/contracts/pool-snapshot.ts';
import {
  createSemanticFreshnessProjector,
  type SemanticFreshnessPolicy,
  type SemanticFreshnessProjector,
} from '../src/freshness/semantic-freshness-projector.ts';
import { createOperatingWindowGate } from '../src/harvesting/operating-window-gate.ts';
import { createPoolNormalizer } from '../src/normalization/pool-normalizer.ts';
import { createSnapshotStore } from '../src/snapshot/snapshot-store.ts';
import { normalizerOptions, sourceCollection } from './support/pool-test-data.ts';

const MINUTE_MS = 60_000;
const REPORTED_AT = Date.parse('2026-06-24T12:00:00.000Z');
const POLICY: SemanticFreshnessPolicy = Object.freeze({
  snapshotCurrentMs: 10 * MINUTE_MS,
  snapshotMaxStaleMs: 60 * MINUTE_MS,
  attendanceCurrentMs: 15 * MINUTE_MS,
  statusCurrentMs: 30 * MINUTE_MS,
  statusMaxStaleMs: 120 * MINUTE_MS,
});

Deno.test('validates all injected freshness durations and required ordering', () => {
  const invalidDuration = createSemanticFreshnessProjector(
    { ...POLICY, attendanceCurrentMs: Number.NaN },
    activeGate(),
  );
  assert(!invalidDuration.ok);
  assertEquals(invalidDuration.error.code, 'invalid-duration');
  assertEquals(invalidDuration.error.field, 'attendanceCurrentMs');

  const attendanceOrder = createSemanticFreshnessProjector(
    { ...POLICY, attendanceCurrentMs: POLICY.statusCurrentMs },
    activeGate(),
  );
  assert(!attendanceOrder.ok);
  assertEquals(attendanceOrder.error.code, 'invalid-order');
  assertEquals(attendanceOrder.error.field, 'attendanceCurrentMs');

  const statusOrder = createSemanticFreshnessProjector(
    { ...POLICY, statusMaxStaleMs: POLICY.statusCurrentMs },
    activeGate(),
  );
  assert(!statusOrder.ok);
  assertEquals(statusOrder.error.field, 'statusMaxStaleMs');

  const snapshotOrder = createSemanticFreshnessProjector(
    { ...POLICY, snapshotMaxStaleMs: POLICY.snapshotCurrentMs },
    activeGate(),
  );
  assert(!snapshotOrder.ok);
  assertEquals(snapshotOrder.error.field, 'snapshotMaxStaleMs');
});

Deno.test('uses inclusive freshness limits and transitions one millisecond after each limit', () => {
  const projector = configuredProjector(activeGate());
  const checkedAt = Date.parse('2026-06-24T12:10:00.000Z');
  const snapshot = snapshotAt(checkedAt, REPORTED_AT);

  assertEquals(
    project(projector, snapshot, checkedAt + POLICY.snapshotCurrentMs).snapshotState,
    'current',
  );
  assertEquals(
    project(projector, snapshot, checkedAt + POLICY.snapshotCurrentMs + 1).snapshotState,
    'degraded',
  );
  assertEquals(
    project(projector, snapshot, checkedAt + POLICY.snapshotMaxStaleMs).snapshotState,
    'degraded',
  );
  assertEquals(
    project(projector, snapshot, checkedAt + POLICY.snapshotMaxStaleMs + 1).snapshotState,
    'unavailable',
  );

  const currentStatus = project(
    projector,
    snapshotAt(REPORTED_AT + POLICY.statusCurrentMs, REPORTED_AT),
    REPORTED_AT + POLICY.statusCurrentMs,
  );
  assertEquals(currentStatus.pools[0]?.dataState, 'current');

  const degradedStatus = project(
    projector,
    snapshotAt(REPORTED_AT + POLICY.statusCurrentMs + 1, REPORTED_AT),
    REPORTED_AT + POLICY.statusCurrentMs + 1,
  );
  assertEquals(degradedStatus.pools[0]?.dataState, 'degraded');

  const unavailableStatus = project(
    projector,
    snapshotAt(REPORTED_AT + POLICY.statusMaxStaleMs + 1, REPORTED_AT),
    REPORTED_AT + POLICY.statusMaxStaleMs + 1,
  );
  assertEquals(unavailableStatus.pools[0]?.dataState, 'unavailable');
  assertEquals(unavailableStatus.pools[0]?.operating.state, 'unavailable');
  assertEquals(unavailableStatus.pools[0]?.maintenance.state, 'unavailable');
  assertEquals(unavailableStatus.pools[0]?.capacity.maximumCapacity.state, 'unavailable');
});

Deno.test('expires attendance before status without mutating the retained snapshot', () => {
  const projector = configuredProjector(activeGate());
  const snapshot = snapshotAt(REPORTED_AT + POLICY.attendanceCurrentMs, REPORTED_AT);
  const serializedBefore = JSON.stringify(snapshot);

  const atLimit = project(
    projector,
    snapshot,
    REPORTED_AT + POLICY.attendanceCurrentMs,
  );
  assertEquals(atLimit.pools[0]?.capacity.attendance.state, 'available');

  const expired = project(
    projector,
    snapshotAt(REPORTED_AT + POLICY.attendanceCurrentMs + 1, REPORTED_AT),
    REPORTED_AT + POLICY.attendanceCurrentMs + 1,
  );
  const firstPool = expired.pools[0];
  assert(firstPool !== undefined);
  assertEquals(firstPool.dataState, 'current');
  assertEquals(firstPool.operating.state, 'available');
  assertEquals(firstPool.capacity.attendance.state, 'unavailable');
  assertEquals(firstPool.capacity.remainingCapacity.state, 'unavailable');
  assertEquals(firstPool.capacity.utilizationPercent.state, 'unavailable');
  assertEquals(firstPool.capacity.maximumCapacity.state, 'available');

  assertEquals(JSON.stringify(snapshot), serializedBefore);
  assertEquals(snapshot.pools[0]?.capacity.attendance.state, 'available');
});

Deno.test('a 304 refresh advances snapshot freshness but not record freshness', () => {
  const projector = configuredProjector(activeGate());
  const store = populatedStore(REPORTED_AT + 10 * MINUTE_MS);
  const refreshedAt = REPORTED_AT + 45 * MINUTE_MS;
  const refreshed = store.refresh(refreshedAt);
  assert(refreshed.ok);

  const projection = project(projector, refreshed.snapshot, refreshedAt);

  assertEquals(projection.snapshotState, 'current');
  assertEquals(projection.pools[0]?.dataState, 'degraded');
  assertEquals(projection.pools[0]?.capacity.attendance.state, 'unavailable');
  assertEquals(projection.pools[0]?.sourceReportedAt, '2026-06-24T12:00:00.000Z');
});

Deno.test('retains serviceable data while collection is paused for closed hours', () => {
  const closesAt = Date.parse('2026-06-24T18:00:00.000Z');
  const nextOpensAt = Date.parse('2026-06-25T10:00:00.000Z');
  const now = Date.parse('2026-06-24T20:00:00.000Z');
  const gate = configuredGate([
    {
      startsAtEpochMs: Date.parse('2026-06-24T10:00:00.000Z'),
      endsAtEpochMs: closesAt,
    },
    {
      startsAtEpochMs: nextOpensAt,
      endsAtEpochMs: Date.parse('2026-06-25T18:00:00.000Z'),
    },
  ]);
  const snapshot = snapshotAt(now, now);

  const projection = project(configuredProjector(gate), snapshot, now);

  assertEquals(projection.collectionState, 'paused-closed-hours');
  assertEquals(projection.nextSourceAccessAt, '2026-06-25T10:00:00.000Z');
  assertEquals(projection.snapshotState, 'current');
  assertEquals(projection.pools[0]?.dataState, 'current');
  const projectedOperating = projection.pools[0]?.operating;
  assert(projectedOperating?.state === 'available');
  assertSame(snapshot.pools[0]?.operating, projectedOperating.value);
});

Deno.test('fails malformed and future timestamps closed without replacing static identity', () => {
  const now = Date.parse('2026-06-24T12:10:00.000Z');
  const projector = configuredProjector(activeGate());
  const valid = snapshotAt(now, REPORTED_AT);
  const invalidChecked = Object.freeze({ ...valid, lastCheckedAt: 'not-an-instant' });

  const unavailableSnapshot = project(projector, invalidChecked, now);
  assertEquals(unavailableSnapshot.snapshotState, 'unavailable');
  assertEquals(unavailableSnapshot.pools[0]?.id, valid.pools[0]?.id);
  assertEquals(unavailableSnapshot.pools[0]?.dataState, 'unavailable');

  const futureRecord = withFirstReportedAt(valid, now + 1);
  const unavailableRecord = project(projector, futureRecord, now);
  assertEquals(unavailableRecord.snapshotState, 'current');
  assertEquals(unavailableRecord.pools[0]?.dataState, 'unavailable');
  assertEquals(unavailableRecord.pools[0]?.operating.state, 'unavailable');
});

Deno.test('reports exact aggregate and per-pool semantic transition instants', () => {
  const now = Date.parse('2026-06-24T12:10:00.000Z');
  const snapshot = snapshotAt(now, REPORTED_AT);
  const projection = project(configuredProjector(activeGate()), snapshot, now);
  const attendanceTransition = REPORTED_AT + POLICY.attendanceCurrentMs + 1;

  assertEquals(projection.pools[0]?.nextTransitionAtEpochMs, attendanceTransition);
  assertEquals(projection.nextTransitionAtEpochMs, attendanceTransition);

  const afterAttendance = project(
    configuredProjector(activeGate()),
    snapshot,
    attendanceTransition,
  );
  assertEquals(
    afterAttendance.nextTransitionAtEpochMs,
    now + POLICY.snapshotCurrentMs + 1,
  );
  assertEquals(
    afterAttendance.pools[0]?.nextTransitionAtEpochMs,
    now + POLICY.snapshotCurrentMs + 1,
  );

  const degradedSnapshot = snapshotAt(
    REPORTED_AT,
    REPORTED_AT + 4 * MINUTE_MS,
  );
  const maskedStatusTransition = project(
    configuredProjector(activeGate()),
    degradedSnapshot,
    REPORTED_AT + 20 * MINUTE_MS,
  );
  assertEquals(maskedStatusTransition.pools[0]?.dataState, 'degraded');
  assertEquals(
    maskedStatusTransition.pools[0]?.nextTransitionAtEpochMs,
    REPORTED_AT + POLICY.snapshotMaxStaleMs + 1,
  );
});

Deno.test('projects empty startup and rejects an invalid projection clock without source access', () => {
  const projector = configuredProjector(activeGate());
  const now = Date.parse('2026-06-24T12:10:00.000Z');

  const startup = project(projector, undefined, now);
  assertEquals(startup.snapshotState, 'unavailable');
  assertEquals(startup.pools.length, 0);

  const invalid = projector.project(undefined, Number.NaN);
  assert(!invalid.ok);
  assertEquals(invalid.error.code, 'invalid-time');
});

function configuredProjector(gate: ReturnType<typeof activeGate>): SemanticFreshnessProjector {
  const result = createSemanticFreshnessProjector(POLICY, gate);
  if (!result.ok) {
    throw new Error(`Unexpected freshness policy error: ${result.error.code}`);
  }
  return result.projector;
}

function activeGate() {
  return configuredGate([{
    startsAtEpochMs: Date.parse('2026-06-24T00:00:00.000Z'),
    endsAtEpochMs: Date.parse('2026-06-26T00:00:00.000Z'),
  }]);
}

function configuredGate(
  windows: readonly Readonly<{ startsAtEpochMs: number; endsAtEpochMs: number }>[],
) {
  const result = createOperatingWindowGate(windows);
  if (!result.ok) {
    throw new Error(`Unexpected operating-window error: ${result.error.code}`);
  }
  return result.gate;
}

function snapshotAt(checkedAtEpochMs: number, firstReportedAtEpochMs: number): PoolSnapshot {
  const store = populatedStore(checkedAtEpochMs);
  const current = store.current();
  assert(current !== undefined);
  return withFirstReportedAt(current, firstReportedAtEpochMs);
}

function populatedStore(checkedAtEpochMs: number) {
  const configured = createPoolNormalizer(normalizerOptions());
  if (!configured.ok) {
    throw new Error(`Unexpected normalizer configuration error: ${configured.error.code}`);
  }
  const normalized = configured.normalizer.normalize(sourceCollection());
  if (!normalized.ok) {
    throw new Error(`Unexpected normalization error: ${normalized.error.code}`);
  }
  const store = createSnapshotStore();
  const published = store.publish(normalized.value, checkedAtEpochMs);
  if (!published.ok) {
    throw new Error(`Unexpected snapshot publication error: ${published.error.code}`);
  }
  return store;
}

function withFirstReportedAt(snapshot: PoolSnapshot, reportedAtEpochMs: number): PoolSnapshot {
  return Object.freeze({
    ...snapshot,
    pools: Object.freeze(
      snapshot.pools.map((pool, index) =>
        index === 0
          ? Object.freeze({ ...pool, sourceReportedAt: new Date(reportedAtEpochMs).toISOString() })
          : pool
      ),
    ),
  });
}

function project(
  projector: SemanticFreshnessProjector,
  snapshot: PoolSnapshot | undefined,
  nowEpochMs: number,
) {
  const result = projector.project(snapshot, nowEpochMs);
  if (!result.ok) {
    throw new Error(`Unexpected freshness projection error: ${result.error.code}`);
  }
  return result.value;
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

function assertSame(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error('Expected references to be identical');
  }
}
