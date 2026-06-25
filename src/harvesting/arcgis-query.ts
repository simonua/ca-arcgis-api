import {
  ARCGIS_COLLECTION_ORIGIN,
  ARCGIS_COLLECTION_PATH,
  ARCGIS_OUT_FIELDS,
} from '../contracts/arcgis-source.ts';

/** Builds the only collection URL the service is permitted to send to ArcGIS. */
export function buildArcGisCollectionUrl(): URL {
  const url = new URL(ARCGIS_COLLECTION_PATH, `${ARCGIS_COLLECTION_ORIGIN}/`);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', ARCGIS_OUT_FIELDS.join(','));
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('orderByFields', 'AssetID');
  url.searchParams.set('f', 'json');
  return url;
}
