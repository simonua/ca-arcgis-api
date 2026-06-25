import type {
  ArcGisSourceCollection,
  ArcGisSourceRecord,
  SourceField,
} from '../contracts/arcgis-source.ts';
import {
  POOL_ACCESS_VALUES,
  POOL_ACTIVITY_VALUES,
  POOL_AREAS,
  POOL_CLOSURE_KINDS,
  POOL_LOCATION_TYPES,
  POOL_MAINTENANCE_COMPONENTS,
  type PoolAccess,
  type PoolActivity,
  type PoolArea,
  type PoolCapacityState,
  type PoolClosureKind,
  type PoolDatum,
  type PoolLocationType,
  type PoolMaintenanceComponent,
  type PoolOperatingState,
  type PoolSnapshotCandidate,
  type PoolSnapshotRecord,
} from '../contracts/pool-snapshot.ts';
import { isPoolApiId } from '../contracts/pool-identity.ts';

const SOURCE_ASSET_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const WEB_APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_SOURCE_DOMAIN_VALUE_LENGTH = 128;

export interface PoolRegistryEntry {
  readonly sourceAssetId: string;
  readonly apiId: string;
  readonly displayName: string;
  readonly locationType: PoolLocationType;
  readonly webAppPoolId: string | null;
}

export interface PoolStatusRule extends PoolOperatingState {
  readonly sourceValue: string;
}

export interface PoolMaintenanceRule {
  readonly sourceValue: string;
  readonly components: readonly PoolMaintenanceComponent[];
}

export type PoolNormalizerConfigurationErrorCode =
  | 'duplicate-api-id'
  | 'duplicate-source-asset-id'
  | 'duplicate-status-rule'
  | 'duplicate-maintenance-rule'
  | 'invalid-registry-entry'
  | 'invalid-status-rule'
  | 'invalid-maintenance-rule';

export interface PoolNormalizerConfigurationError {
  readonly code: PoolNormalizerConfigurationErrorCode;
  readonly entryIndex: number;
}

export type PoolNormalizationErrorCode =
  | 'duplicate-source-record'
  | 'missing-source-record'
  | 'unknown-source-record'
  | 'unknown-status';

export interface PoolNormalizationError {
  readonly code: PoolNormalizationErrorCode;
  readonly recordIndex?: number;
}

export type PoolNormalizationResult =
  | Readonly<{ ok: true; value: PoolSnapshotCandidate }>
  | Readonly<{ ok: false; error: PoolNormalizationError }>;

export interface PoolNormalizer {
  normalize(collection: ArcGisSourceCollection): PoolNormalizationResult;
}

export type PoolNormalizerCreationResult =
  | Readonly<{ ok: true; normalizer: PoolNormalizer }>
  | Readonly<{ ok: false; error: PoolNormalizerConfigurationError }>;

export interface PoolNormalizerOptions {
  readonly registry: readonly PoolRegistryEntry[];
  readonly statusRules: readonly PoolStatusRule[];
  readonly maintenanceRules: readonly PoolMaintenanceRule[];
}

/** Creates a consumer-model normalizer from reviewed registry and source-domain policies. */
export function createPoolNormalizer(options: PoolNormalizerOptions): PoolNormalizerCreationResult {
  const registryResult = validateRegistry(options.registry);
  if (!registryResult.ok) {
    return registryResult;
  }
  const statusResult = validateStatusRules(options.statusRules);
  if (!statusResult.ok) {
    return statusResult;
  }
  const maintenanceResult = validateMaintenanceRules(options.maintenanceRules);
  if (!maintenanceResult.ok) {
    return maintenanceResult;
  }

  const registry = Object.freeze(options.registry.map(freezeRegistryEntry));
  const statusRules = new Map(
    options.statusRules.map((rule) => [rule.sourceValue, freezeOperatingState(rule)]),
  );
  const maintenanceRules = new Map(
    options.maintenanceRules.map((rule) => [rule.sourceValue, Object.freeze([...rule.components])]),
  );

  return Object.freeze({
    ok: true,
    normalizer: Object.freeze({
      normalize(collection: ArcGisSourceCollection): PoolNormalizationResult {
        const sourceRecords = new Map<
          string,
          Readonly<{ record: ArcGisSourceRecord; index: number }>
        >();
        for (const [recordIndex, record] of collection.records.entries()) {
          if (sourceRecords.has(record.assetId)) {
            return normalizationFailure('duplicate-source-record', recordIndex);
          }
          sourceRecords.set(record.assetId, Object.freeze({ record, index: recordIndex }));
        }
        if (sourceRecords.size > registry.length) {
          return normalizationFailure('unknown-source-record');
        }

        const pools: PoolSnapshotRecord[] = [];
        for (const entry of registry) {
          const source = sourceRecords.get(entry.sourceAssetId);
          if (source === undefined) {
            return normalizationFailure('missing-source-record');
          }
          const operating = statusRules.get(source.record.sourceStatus);
          if (operating === undefined) {
            return normalizationFailure('unknown-status', source.index);
          }

          pools.push(Object.freeze({
            id: entry.apiId,
            displayName: entry.displayName,
            locationType: entry.locationType,
            webAppPoolId: entry.webAppPoolId,
            operating,
            maintenance: normalizeMaintenance(
              source.record.sourceMaintenanceStatus,
              maintenanceRules,
            ),
            capacity: normalizeCapacity(
              source.record.sourceAttendance,
              source.record.sourceMaximumCapacity,
              operating.access !== 'unknown',
            ),
            sourceReportedAt: new Date(source.record.sourceReportedAtEpochMs).toISOString(),
          }));
          sourceRecords.delete(entry.sourceAssetId);
        }
        if (sourceRecords.size !== 0) {
          return normalizationFailure('unknown-source-record');
        }
        return Object.freeze({
          ok: true,
          value: Object.freeze({ pools: Object.freeze(pools) }),
        });
      },
    }),
  });
}

function validateRegistry(
  entries: readonly PoolRegistryEntry[],
): PoolNormalizerCreationResult | Readonly<{ ok: true }> {
  const sourceIds = new Set<string>();
  const apiIds = new Set<string>();
  if (entries.length === 0) {
    return configurationFailure('invalid-registry-entry', 0);
  }
  for (const [entryIndex, entry] of entries.entries()) {
    if (
      !SOURCE_ASSET_ID_PATTERN.test(entry.sourceAssetId) || !isPoolApiId(entry.apiId) ||
      !validDisplayName(entry.displayName) ||
      !LOCATION_TYPES.has(entry.locationType) ||
      (entry.webAppPoolId !== null && !WEB_APP_ID_PATTERN.test(entry.webAppPoolId))
    ) {
      return configurationFailure('invalid-registry-entry', entryIndex);
    }
    if (sourceIds.has(entry.sourceAssetId)) {
      return configurationFailure('duplicate-source-asset-id', entryIndex);
    }
    if (apiIds.has(entry.apiId)) {
      return configurationFailure('duplicate-api-id', entryIndex);
    }
    sourceIds.add(entry.sourceAssetId);
    apiIds.add(entry.apiId);
  }
  return Object.freeze({ ok: true });
}

function validateStatusRules(
  rules: readonly PoolStatusRule[],
): PoolNormalizerCreationResult | Readonly<{ ok: true }> {
  const sourceValues = new Set<string>();
  if (rules.length === 0) {
    return configurationFailure('invalid-status-rule', 0);
  }
  for (const [entryIndex, rule] of rules.entries()) {
    if (!validSourceDomainValue(rule.sourceValue) || !validOperatingState(rule)) {
      return configurationFailure('invalid-status-rule', entryIndex);
    }
    if (sourceValues.has(rule.sourceValue)) {
      return configurationFailure('duplicate-status-rule', entryIndex);
    }
    sourceValues.add(rule.sourceValue);
  }
  return Object.freeze({ ok: true });
}

function validateMaintenanceRules(
  rules: readonly PoolMaintenanceRule[],
): PoolNormalizerCreationResult | Readonly<{ ok: true }> {
  const sourceValues = new Set<string>();
  for (const [entryIndex, rule] of rules.entries()) {
    if (
      !validSourceDomainValue(rule.sourceValue) ||
      new Set(rule.components).size !== rule.components.length ||
      rule.components.some((component) => !MAINTENANCE_COMPONENTS.has(component))
    ) {
      return configurationFailure('invalid-maintenance-rule', entryIndex);
    }
    if (sourceValues.has(rule.sourceValue)) {
      return configurationFailure('duplicate-maintenance-rule', entryIndex);
    }
    sourceValues.add(rule.sourceValue);
  }
  return Object.freeze({ ok: true });
}

const LOCATION_TYPES: ReadonlySet<PoolLocationType> = new Set(POOL_LOCATION_TYPES);
const ACCESS_VALUES: ReadonlySet<PoolAccess> = new Set(POOL_ACCESS_VALUES);
const ACTIVITY_VALUES: ReadonlySet<PoolActivity> = new Set(POOL_ACTIVITY_VALUES);
const CLOSURE_VALUES: ReadonlySet<PoolClosureKind> = new Set(POOL_CLOSURE_KINDS);
const AREA_VALUES: ReadonlySet<PoolArea> = new Set(POOL_AREAS);
const MAINTENANCE_COMPONENTS: ReadonlySet<PoolMaintenanceComponent> = new Set(
  POOL_MAINTENANCE_COMPONENTS,
);

function validOperatingState(rule: PoolStatusRule): boolean {
  const validAreas = new Set(rule.availableAreas).size === rule.availableAreas.length &&
    rule.availableAreas.every((area) => AREA_VALUES.has(area));
  const validAreaContract = rule.access === 'partial'
    ? rule.availableAreas.length > 0
    : rule.availableAreas.length === 0;
  return ACCESS_VALUES.has(rule.access) && ACTIVITY_VALUES.has(rule.activity) &&
    CLOSURE_VALUES.has(rule.closureKind) &&
    validAreas && validAreaContract;
}

function normalizeMaintenance(
  field: SourceField<string>,
  rules: ReadonlyMap<string, readonly PoolMaintenanceComponent[]>,
): PoolDatum<readonly PoolMaintenanceComponent[]> {
  if (field.state === 'unavailable') {
    return unavailable();
  }
  const components = rules.get(field.value);
  return components === undefined ? unavailable() : available(components);
}

function normalizeCapacity(
  attendanceField: SourceField<number>,
  maximumCapacityField: SourceField<number>,
  attendanceRelevant: boolean,
): PoolCapacityState {
  const acceptedAttendance = attendanceRelevant && attendanceField.state === 'accepted' &&
      Number.isSafeInteger(attendanceField.value) && attendanceField.value >= 0
    ? attendanceField.value
    : undefined;
  const acceptedMaximum = maximumCapacityField.state === 'accepted' &&
      Number.isSafeInteger(maximumCapacityField.value) && maximumCapacityField.value > 0
    ? maximumCapacityField.value
    : undefined;
  const attendance = acceptedAttendance !== undefined &&
      (acceptedMaximum === undefined || acceptedAttendance <= acceptedMaximum)
    ? available(acceptedAttendance)
    : unavailable<number>();
  const maximumCapacity = acceptedMaximum === undefined
    ? unavailable<number>()
    : available(acceptedMaximum);
  const canDerive = attendance.state === 'available' && maximumCapacity.state === 'available';
  return Object.freeze({
    attendance,
    maximumCapacity,
    remainingCapacity: canDerive
      ? available(maximumCapacity.value - attendance.value)
      : unavailable<number>(),
    utilizationPercent: canDerive
      ? available((attendance.value / maximumCapacity.value) * 100)
      : unavailable<number>(),
  });
}

function freezeRegistryEntry(entry: PoolRegistryEntry): PoolRegistryEntry {
  return Object.freeze({ ...entry });
}

function freezeOperatingState(rule: PoolStatusRule): PoolOperatingState {
  return Object.freeze({
    access: rule.access,
    activity: rule.activity,
    closureKind: rule.closureKind,
    availableAreas: Object.freeze([...rule.availableAreas]),
  });
}

function available<T>(value: T): PoolDatum<T> {
  return Object.freeze({ state: 'available', value });
}

function unavailable<T>(): PoolDatum<T> {
  return Object.freeze({ state: 'unavailable' });
}

function validDisplayName(value: string): boolean {
  return value.trim().length > 0 && value.length <= MAX_DISPLAY_NAME_LENGTH &&
    !containsControlCharacter(value);
}

function validSourceDomainValue(value: string): boolean {
  return value.trim().length > 0 && value.length <= MAX_SOURCE_DOMAIN_VALUE_LENGTH &&
    !containsControlCharacter(value);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function configurationFailure(
  code: PoolNormalizerConfigurationErrorCode,
  entryIndex: number,
): PoolNormalizerCreationResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, entryIndex }) });
}

function normalizationFailure(
  code: PoolNormalizationErrorCode,
  recordIndex?: number,
): PoolNormalizationResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, ...(recordIndex === undefined ? {} : { recordIndex }) }),
  });
}
