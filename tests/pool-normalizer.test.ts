import { createPoolNormalizer } from '../src/normalization/pool-normalizer.ts';
import { accepted, normalizerOptions, sourceCollection } from './support/pool-test-data.ts';

Deno.test('pool normalizer publishes only consumer-owned identity and semantic values', () => {
  const normalizer = requireNormalizer();

  const result = normalizer.normalize(sourceCollection());

  assert(result.ok, 'Expected synthetic collection to normalize');
  const first = result.value.pools[0];
  assert(first !== undefined, 'Expected first normalized pool');
  assertEquals(first.id, 'river-hill');
  assertEquals(first.displayName, 'River Hill Pool');
  assertEquals(first.locationType, 'outdoor');
  assertEquals(first.webAppPoolId, 'river-hill');
  assertEquals(first.operating.access, 'open-public');
  assertEquals(first.operating.activity, 'rec-swim');
  assertEquals(first.capacity.attendance, { state: 'available', value: 25 });
  assertEquals(first.capacity.remainingCapacity, { state: 'available', value: 75 });
  assertEquals(first.sourceReportedAt, '2026-06-24T12:00:00.000Z');

  const serialized = JSON.stringify(result.value);
  for (
    const sourceOnlyValue of [
      'ASSET_SYNTHETIC_1',
      'No Ongoing Maintenance',
      'Open',
      'AssetID',
      'Status2',
      'EditDate',
    ]
  ) {
    assert(!serialized.includes(sourceOnlyValue), `Leaked source-only value: ${sourceOnlyValue}`);
  }
});

Deno.test('pool normalizer isolates unknown maintenance and invalid attendance', () => {
  const normalizer = requireNormalizer();
  const records = sourceCollection().records.map((record, index) =>
    index === 0
      ? Object.freeze({
        ...record,
        sourceMaintenanceStatus: accepted('Unreviewed Maintenance Label'),
        sourceAttendance: accepted(101),
      })
      : record
  );

  const result = normalizer.normalize(Object.freeze({ records: Object.freeze(records) }));

  assert(result.ok, 'Expected field-level failures to remain isolated');
  const first = result.value.pools[0];
  assert(first !== undefined, 'Expected first normalized pool');
  assertEquals(first.maintenance, { state: 'unavailable' });
  assertEquals(first.capacity.attendance, { state: 'unavailable' });
  assertEquals(first.capacity.maximumCapacity, { state: 'available', value: 100 });
  assertEquals(first.capacity.remainingCapacity, { state: 'unavailable' });
  assertEquals(first.capacity.utilizationPercent, { state: 'unavailable' });
});

Deno.test('pool normalizer rejects unknown operating status and missing registry record', () => {
  const normalizer = requireNormalizer();
  const unknownStatus = normalizer.normalize(
    sourceCollection({ firstStatus: 'Unreviewed Status' }),
  );
  const missingRecord = normalizer.normalize(Object.freeze({
    records: Object.freeze(sourceCollection().records.slice(0, 1)),
  }));

  assert(!unknownStatus.ok, 'Expected unknown operating status rejection');
  assertEquals(unknownStatus.error.code, 'unknown-status');
  assert(!missingRecord.ok, 'Expected complete registry-shaped collection');
  assertEquals(missingRecord.error.code, 'missing-source-record');
});

Deno.test('pool normalizer configuration fails closed without registry or status policy', () => {
  const noRegistry = createPoolNormalizer({ ...normalizerOptions(), registry: [] });
  const noStatusRules = createPoolNormalizer({ ...normalizerOptions(), statusRules: [] });

  assert(!noRegistry.ok, 'Expected empty registry rejection');
  assertEquals(noRegistry.error.code, 'invalid-registry-entry');
  assert(!noStatusRules.ok, 'Expected empty status policy rejection');
  assertEquals(noStatusRules.error.code, 'invalid-status-rule');
});

function requireNormalizer() {
  const result = createPoolNormalizer(normalizerOptions());
  if (!result.ok) {
    throw new Error(`Unexpected normalizer configuration error: ${result.error.code}`);
  }
  return result.normalizer;
}

function assert(condition: boolean, message = 'Assertion failed'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
