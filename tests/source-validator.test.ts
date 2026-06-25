import validResponse from './fixtures/arcgis-valid-response.json' with { type: 'json' };
import { validateArcGisSourceResponse } from '../src/harvesting/source-validator.ts';

const EXPECTED_ASSET_IDS = new Set(['TEST-001', 'TEST-002']);
const NOW_EPOCH_MS = 1782345900000;

Deno.test('accepts a complete synthetic collection as immutable source records', () => {
  const result = validate(validResponse);

  assert(result.ok, result.ok ? '' : result.error.code);
  assertEquals(result.value.records.length, 2);
  assert(Object.isFrozen(result.value));
  assert(Object.isFrozen(result.value.records));

  const first = result.value.records.at(0);
  const second = result.value.records.at(1);
  assert(first !== undefined);
  assert(second !== undefined);
  assert(Object.isFrozen(first));
  assertEquals(first.assetId, 'TEST-001');
  assertEquals(first.sourceAttendance.state, 'accepted');
  assertEquals(second.sourceMaintenanceStatus.state, 'unavailable');
  assertEquals(second.sourceAttendance.state, 'unavailable');
});

Deno.test('rejects ArcGIS error and truncated envelopes', () => {
  assertFailureCode({ error: { code: 500, message: 'Synthetic failure' } }, 'arcgis_error');
  assertFailureCode(
    { ...validResponse, exceededTransferLimit: true },
    'transfer_limit_exceeded',
  );
});

Deno.test('rejects geometry and attributes outside the field allowlist', () => {
  const withGeometry = {
    ...validResponse,
    features: validResponse.features.map((feature, index) =>
      index === 0 ? { ...feature, geometry: { x: 0, y: 0 } } : feature
    ),
  };
  assertFailureCode(withGeometry, 'unexpected_geometry');

  const withEditorIdentity = {
    ...validResponse,
    features: validResponse.features.map((feature, index) =>
      index === 0 ? { attributes: { ...feature.attributes, Editor: 'synthetic-editor' } } : feature
    ),
  };
  assertFailureCode(withEditorIdentity, 'unexpected_attribute');
});

Deno.test('rejects malformed, duplicate, unknown, and missing identities', () => {
  const malformed = replaceAssetId(0, '../unsafe');
  assertFailureCode(malformed, 'invalid_asset_id');

  const duplicate = replaceAssetId(1, 'TEST-001');
  assertFailureCode(duplicate, 'duplicate_asset_id');

  const unknown = replaceAssetId(1, 'TEST-003');
  assertFailureCode(unknown, 'unknown_asset_id');

  const missing = {
    ...validResponse,
    features: validResponse.features.slice(0, 1),
  };
  assertFailureCode(missing, 'missing_expected_asset_id');
});

Deno.test('rejects invalid required status and reported timestamps', () => {
  const invalidStatus = replaceAttribute(0, 'Status', '   ');
  assertFailureCode(invalidStatus, 'invalid_status');

  const statusWithControlCharacter = replaceAttribute(0, 'Status', 'Open\nInjected');
  assertFailureCode(statusWithControlCharacter, 'invalid_status');

  const futureTimestamp = replaceAttribute(0, 'EditDate', NOW_EPOCH_MS + 300001);
  assertFailureCode(futureTimestamp, 'invalid_reported_at');
});

Deno.test('marks an invalid optional field unavailable without rejecting the collection', () => {
  const invalidAttendance = replaceAttribute(0, 'Pool_Attendance', 'many');
  const result = validate(invalidAttendance);

  assert(result.ok, result.ok ? '' : result.error.code);
  const first = result.value.records.at(0);
  assert(first !== undefined);
  assertEquals(first.sourceAttendance.state, 'unavailable');
  if (first.sourceAttendance.state === 'unavailable') {
    assertEquals(first.sourceAttendance.reason, 'invalid-type');
  }
});

function validate(input: unknown) {
  return validateArcGisSourceResponse(input, {
    expectedAssetIds: EXPECTED_ASSET_IDS,
    nowEpochMs: NOW_EPOCH_MS,
  });
}

function assertFailureCode(input: unknown, expectedCode: string): void {
  const result = validate(input);
  assert(!result.ok, 'Expected source validation to fail');
  assertEquals(result.error.code, expectedCode);
}

function replaceAssetId(featureIndex: number, assetId: string): unknown {
  return replaceAttribute(featureIndex, 'AssetID', assetId);
}

function replaceAttribute(featureIndex: number, field: string, value: unknown): unknown {
  return {
    ...validResponse,
    features: validResponse.features.map((feature, index) =>
      index === featureIndex ? { attributes: { ...feature.attributes, [field]: value } } : feature
    ),
  };
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
