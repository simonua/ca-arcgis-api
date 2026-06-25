import {
  ARCGIS_OUT_FIELDS,
  type ArcGisOutField,
  type ArcGisSourceCollection,
  type ArcGisSourceRecord,
  type SourceField,
  type SourceFieldUnavailableReason,
} from '../contracts/arcgis-source.ts';

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_MINIMUM_REPORTED_AT_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_SOURCE_STRING_LENGTH = 256;
const ASSET_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const APPROVED_ATTRIBUTE_NAMES = new Set<string>(ARCGIS_OUT_FIELDS);

export type SourceValidationErrorCode =
  | 'arcgis_error'
  | 'duplicate_asset_id'
  | 'invalid_asset_id'
  | 'invalid_attributes'
  | 'invalid_envelope'
  | 'invalid_feature'
  | 'invalid_reported_at'
  | 'invalid_status'
  | 'missing_expected_asset_id'
  | 'transfer_limit_exceeded'
  | 'unexpected_attribute'
  | 'unexpected_geometry'
  | 'unknown_asset_id';

export interface SourceValidationError {
  readonly code: SourceValidationErrorCode;
  readonly featureIndex?: number;
}

type SourceValidationFailure = Readonly<{ ok: false; error: SourceValidationError }>;

export type SourceValidationResult =
  | Readonly<{ ok: true; value: ArcGisSourceCollection }>
  | SourceValidationFailure;

export interface SourceValidationOptions {
  readonly expectedAssetIds: ReadonlySet<string>;
  readonly nowEpochMs: number;
  readonly maxFutureSkewMs?: number;
  readonly minimumReportedAtEpochMs?: number;
}

/** Narrows an untrusted ArcGIS collection response without retaining raw feature objects. */
export function validateArcGisSourceResponse(
  input: unknown,
  options: SourceValidationOptions,
): SourceValidationResult {
  if (!isRecord(input)) {
    return failure('invalid_envelope');
  }

  if (Object.hasOwn(input, 'error')) {
    return failure('arcgis_error');
  }

  if (Object.hasOwn(input, 'exceededTransferLimit')) {
    if (typeof input.exceededTransferLimit !== 'boolean') {
      return failure('invalid_envelope');
    }
    if (input.exceededTransferLimit) {
      return failure('transfer_limit_exceeded');
    }
  }

  if (!Array.isArray(input.features)) {
    return failure('invalid_envelope');
  }

  const records: ArcGisSourceRecord[] = [];
  const seenAssetIds = new Set<string>();

  for (const [featureIndex, feature] of input.features.entries()) {
    const result = validateFeature(feature, featureIndex, options);
    if (!result.ok) {
      return result;
    }

    if (seenAssetIds.has(result.value.assetId)) {
      return failure('duplicate_asset_id', featureIndex);
    }
    if (!options.expectedAssetIds.has(result.value.assetId)) {
      return failure('unknown_asset_id', featureIndex);
    }

    seenAssetIds.add(result.value.assetId);
    records.push(result.value);
  }

  if (seenAssetIds.size !== options.expectedAssetIds.size) {
    return failure('missing_expected_asset_id');
  }
  for (const expectedAssetId of options.expectedAssetIds) {
    if (!seenAssetIds.has(expectedAssetId)) {
      return failure('missing_expected_asset_id');
    }
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({ records: Object.freeze(records) }),
  });
}

type FeatureValidationResult =
  | Readonly<{ ok: true; value: ArcGisSourceRecord }>
  | SourceValidationFailure;

function validateFeature(
  input: unknown,
  featureIndex: number,
  options: SourceValidationOptions,
): FeatureValidationResult {
  if (!isRecord(input)) {
    return failure('invalid_feature', featureIndex);
  }
  if (Object.hasOwn(input, 'geometry')) {
    return failure('unexpected_geometry', featureIndex);
  }
  if (Object.keys(input).some((key) => key !== 'attributes')) {
    return failure('invalid_feature', featureIndex);
  }
  if (!isRecord(input.attributes)) {
    return failure('invalid_attributes', featureIndex);
  }

  const attributes = input.attributes;
  if (Object.keys(attributes).some((key) => !APPROVED_ATTRIBUTE_NAMES.has(key))) {
    return failure('unexpected_attribute', featureIndex);
  }

  const assetId = readRequiredAssetId(attributes.AssetID);
  if (assetId === undefined) {
    return failure('invalid_asset_id', featureIndex);
  }

  const sourceStatus = readRequiredString(attributes.Status, 128);
  if (sourceStatus === undefined) {
    return failure('invalid_status', featureIndex);
  }

  const sourceReportedAtEpochMs = readReportedAt(attributes.EditDate, options);
  if (sourceReportedAtEpochMs === undefined) {
    return failure('invalid_reported_at', featureIndex);
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      assetId,
      sourceName: readOptionalString(attributes, 'Name'),
      sourcePoolName: readOptionalString(attributes, 'Pool_Name'),
      sourceLocation: readOptionalString(attributes, 'pool_location'),
      sourceStatus,
      sourceMaintenanceStatus: readOptionalString(attributes, 'Status2'),
      sourceAttendance: readOptionalNumber(attributes, 'Pool_Attendance'),
      sourceMaximumCapacity: readOptionalNumber(attributes, 'Pool_Capacity'),
      sourceReportedAtEpochMs,
    }),
  });
}

function readRequiredAssetId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

function readRequiredString(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength ||
    containsControlCharacter(value)
  ) {
    return undefined;
  }
  return value;
}

function readReportedAt(value: unknown, options: SourceValidationOptions): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return undefined;
  }

  const minimum = options.minimumReportedAtEpochMs ?? DEFAULT_MINIMUM_REPORTED_AT_EPOCH_MS;
  const maximum = options.nowEpochMs + (options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS);
  if (
    !Number.isFinite(minimum) || !Number.isFinite(maximum) || value < minimum || value > maximum
  ) {
    return undefined;
  }
  return value;
}

function readOptionalString(
  attributes: Record<string, unknown>,
  field: ArcGisOutField,
): SourceField<string> {
  if (!Object.hasOwn(attributes, field) || attributes[field] === null) {
    return unavailable('missing');
  }
  if (typeof attributes[field] !== 'string') {
    return unavailable('invalid-type');
  }

  const value = attributes[field];
  if (
    value.trim().length === 0 || value.length > MAX_SOURCE_STRING_LENGTH ||
    containsControlCharacter(value)
  ) {
    return unavailable('invalid-value');
  }
  return Object.freeze({ state: 'accepted', value });
}

function readOptionalNumber(
  attributes: Record<string, unknown>,
  field: ArcGisOutField,
): SourceField<number> {
  if (!Object.hasOwn(attributes, field) || attributes[field] === null) {
    return unavailable('missing');
  }
  if (typeof attributes[field] !== 'number') {
    return unavailable('invalid-type');
  }

  const value = attributes[field];
  if (!Number.isFinite(value)) {
    return unavailable('invalid-value');
  }
  return Object.freeze({ state: 'accepted', value });
}

function unavailable<T>(reason: SourceFieldUnavailableReason): SourceField<T> {
  return Object.freeze({ state: 'unavailable', reason });
}

function failure(code: SourceValidationErrorCode, featureIndex?: number): SourceValidationFailure {
  const error: SourceValidationError = featureIndex === undefined
    ? Object.freeze({ code })
    : Object.freeze({ code, featureIndex });
  return Object.freeze({ ok: false, error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}
