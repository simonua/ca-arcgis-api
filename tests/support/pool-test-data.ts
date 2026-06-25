import type {
  ArcGisSourceCollection,
  ArcGisSourceRecord,
} from '../../src/contracts/arcgis-source.ts';
import type { PoolNormalizerOptions } from '../../src/normalization/pool-normalizer.ts';

export function normalizerOptions(): PoolNormalizerOptions {
  return Object.freeze({
    registry: Object.freeze([
      Object.freeze({
        sourceAssetId: 'ASSET_SYNTHETIC_1',
        apiId: 'river-hill',
        displayName: 'River Hill Pool',
        locationType: 'outdoor' as const,
        webAppPoolId: 'river-hill',
      }),
      Object.freeze({
        sourceAssetId: 'ASSET_SYNTHETIC_2',
        apiId: 'athletic-club',
        displayName: 'Athletic Club Pool',
        locationType: 'indoor' as const,
        webAppPoolId: null,
      }),
    ]),
    statusRules: Object.freeze([
      Object.freeze({
        sourceValue: 'Open',
        access: 'open-public' as const,
        activity: 'rec-swim' as const,
        closureKind: 'none' as const,
        availableAreas: Object.freeze([]),
      }),
      Object.freeze({
        sourceValue: 'Closed (Maintenance)',
        access: 'closed' as const,
        activity: 'none' as const,
        closureKind: 'maintenance' as const,
        availableAreas: Object.freeze([]),
      }),
    ]),
    maintenanceRules: Object.freeze([
      Object.freeze({
        sourceValue: 'No Ongoing Maintenance',
        components: Object.freeze([]),
      }),
    ]),
  });
}

export function sourceCollection(
  overrides: Readonly<{ firstStatus?: string }> = {},
): ArcGisSourceCollection {
  return Object.freeze({
    records: Object.freeze([
      record({
        assetId: 'ASSET_SYNTHETIC_1',
        sourceName: 'Source Name One',
        sourcePoolName: 'Source Pool One',
        sourceLocation: 'Source Location One',
        sourceStatus: overrides.firstStatus ?? 'Open',
        attendance: 25,
        capacity: 100,
        reportedAt: Date.parse('2026-06-24T12:00:00.000Z'),
      }),
      record({
        assetId: 'ASSET_SYNTHETIC_2',
        sourceName: 'Source Name Two',
        sourcePoolName: 'Source Pool Two',
        sourceLocation: 'Source Location Two',
        sourceStatus: 'Closed (Maintenance)',
        attendance: 0,
        capacity: 80,
        reportedAt: Date.parse('2026-06-24T12:05:00.000Z'),
      }),
    ]),
  });
}

export function accepted<T>(value: T): Readonly<{ state: 'accepted'; value: T }> {
  return Object.freeze({ state: 'accepted', value });
}

function record(
  input: Readonly<{
    assetId: string;
    sourceName: string;
    sourcePoolName: string;
    sourceLocation: string;
    sourceStatus: string;
    attendance: number;
    capacity: number;
    reportedAt: number;
  }>,
): ArcGisSourceRecord {
  return Object.freeze({
    assetId: input.assetId,
    sourceName: accepted(input.sourceName),
    sourcePoolName: accepted(input.sourcePoolName),
    sourceLocation: accepted(input.sourceLocation),
    sourceStatus: input.sourceStatus,
    sourceMaintenanceStatus: accepted('No Ongoing Maintenance'),
    sourceAttendance: accepted(input.attendance),
    sourceMaximumCapacity: accepted(input.capacity),
    sourceReportedAtEpochMs: input.reportedAt,
  });
}
