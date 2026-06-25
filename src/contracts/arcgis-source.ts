export const ARCGIS_COLLECTION_ORIGIN = 'https://services8.arcgis.com' as const;

export const ARCGIS_COLLECTION_PATH =
  '/Qah4YRlnA96tI4X9/arcgis/rest/services/CA_Ammenities/FeatureServer/0/query' as const;

export const ARCGIS_OUT_FIELDS = [
  'AssetID',
  'Status',
  'Status2',
  'Pool_Attendance',
  'Pool_Capacity',
  'EditDate',
] as const;

export type ArcGisOutField = (typeof ARCGIS_OUT_FIELDS)[number];

export type SourceFieldUnavailableReason = 'missing' | 'invalid-type' | 'invalid-value';

export type SourceField<T> =
  | Readonly<{ state: 'accepted'; value: T }>
  | Readonly<{ state: 'unavailable'; reason: SourceFieldUnavailableReason }>;

/** A source record narrowed at the ArcGIS boundary but not yet normalized for the public API. */
export interface ArcGisSourceRecord {
  readonly assetId: string;
  readonly sourceStatus: string;
  readonly sourceMaintenanceStatus: SourceField<string>;
  readonly sourceAttendance: SourceField<number>;
  readonly sourceMaximumCapacity: SourceField<number>;
  readonly sourceReportedAtEpochMs: number;
}

export interface ArcGisSourceCollection {
  readonly records: readonly ArcGisSourceRecord[];
}
