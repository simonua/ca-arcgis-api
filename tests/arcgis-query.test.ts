import {
  ARCGIS_COLLECTION_ORIGIN,
  ARCGIS_COLLECTION_PATH,
  ARCGIS_OUT_FIELDS,
} from '../src/contracts/arcgis-source.ts';
import { buildArcGisCollectionUrl } from '../src/harvesting/arcgis-query.ts';

const EXPECTED_OUT_FIELDS =
  'AssetID,Status,Status2,Pool_Attendance,Pool_Capacity,EditDate' as const;

Deno.test('builds the fixed field-limited ArcGIS collection URL', () => {
  const url = buildArcGisCollectionUrl();

  assertEquals(url.origin, ARCGIS_COLLECTION_ORIGIN);
  assertEquals(url.pathname, ARCGIS_COLLECTION_PATH);
  assertEquals(url.searchParams.get('where'), '1=1');
  assertEquals(url.searchParams.get('outFields'), ARCGIS_OUT_FIELDS.join(','));
  assertEquals(url.searchParams.get('outFields'), EXPECTED_OUT_FIELDS);
  assertEquals(ARCGIS_OUT_FIELDS.length, 6);
  assertEquals(url.searchParams.get('returnGeometry'), 'false');
  assertEquals(url.searchParams.get('orderByFields'), 'AssetID');
  assertEquals(url.searchParams.get('f'), 'json');
  assertEquals([...url.searchParams.keys()].length, 5);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
