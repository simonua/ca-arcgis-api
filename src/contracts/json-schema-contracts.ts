import { ARCGIS_OUT_FIELDS } from './arcgis-source.ts';
import {
  POOL_ACCESS_VALUES,
  POOL_ACTIVITY_VALUES,
  POOL_AREAS,
  POOL_CLOSURE_KINDS,
  POOL_LOCATION_TYPES,
  POOL_MAINTENANCE_COMPONENTS,
  POOL_SNAPSHOT_SCHEMA_VERSION,
} from './pool-snapshot.ts';
import { OPENAPI_COMPONENTS } from '../http/openapi-contract.ts';

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_BASE_ID = 'https://api.pools.longreachmarlins.org/schemas/';
const SOURCE_ASSET_ID_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$';
const API_POOL_ID_PATTERN = '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$';
const SAFE_SOURCE_STRING_PATTERN = '^[^\\u0000-\\u001F\\u007F]+$';

export const JSON_SCHEMA_ARTIFACTS = Object.freeze({
  'arcgis-source-response.schema.json': arcGisSourceResponseSchema(),
  'pool-snapshot.schema.json': poolSnapshotSchema(),
  'public-api-responses.schema.json': publicApiResponsesSchema(),
});

export type JsonSchemaArtifactName = keyof typeof JSON_SCHEMA_ARTIFACTS;

function arcGisSourceResponseSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${SCHEMA_BASE_ID}arcgis-source-response.schema.json`,
    title: 'ArcGIS pool status source response',
    description:
      'Review artifact for the fixed ArcGIS response shape. Runtime identity and time checks remain authoritative.',
    type: 'object',
    required: Object.freeze(['features']),
    properties: Object.freeze({
      exceededTransferLimit: Object.freeze({ type: 'boolean', const: false }),
      features: Object.freeze({
        type: 'array',
        items: Object.freeze({ $ref: '#/$defs/feature' }),
      }),
    }),
    additionalProperties: false,
    $defs: Object.freeze({
      feature: objectSchema(
        ['attributes'],
        { attributes: Object.freeze({ $ref: '#/$defs/attributes' }) },
      ),
      attributes: Object.freeze({
        type: 'object',
        required: Object.freeze(['AssetID', 'Status', 'EditDate']),
        properties: Object.freeze(
          {
            AssetID: Object.freeze({ type: 'string', pattern: SOURCE_ASSET_ID_PATTERN }),
            Status: Object.freeze({
              type: 'string',
              minLength: 1,
              maxLength: 128,
              pattern: SAFE_SOURCE_STRING_PATTERN,
            }),
            Status2: nullableSourceString(),
            Pool_Attendance: nullableNumber(),
            Pool_Capacity: nullableNumber(),
            EditDate: Object.freeze({ type: 'integer', minimum: Date.UTC(2000, 0, 1) }),
          } satisfies Record<(typeof ARCGIS_OUT_FIELDS)[number], unknown>,
        ),
        additionalProperties: false,
      }),
    }),
  });
}

function poolSnapshotSchema(): Readonly<Record<string, unknown>> {
  const nonNegativeDatum = datumSchema(Object.freeze({ type: 'number', minimum: 0 }));
  return Object.freeze({
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${SCHEMA_BASE_ID}pool-snapshot.schema.json`,
    title: 'Normalized immutable pool snapshot',
    type: 'object',
    required: Object.freeze(['schemaVersion', 'generation', 'lastCheckedAt', 'pools']),
    properties: Object.freeze({
      schemaVersion: Object.freeze({ type: 'string', const: POOL_SNAPSHOT_SCHEMA_VERSION }),
      generation: Object.freeze({ type: 'integer', minimum: 1 }),
      lastCheckedAt: instantSchema(),
      pools: Object.freeze({ type: 'array', items: Object.freeze({ $ref: '#/$defs/pool' }) }),
    }),
    additionalProperties: false,
    $defs: Object.freeze({
      pool: objectSchema(
        [
          'id',
          'displayName',
          'locationType',
          'webAppPoolId',
          'operating',
          'maintenance',
          'capacity',
          'sourceReportedAt',
        ],
        {
          id: Object.freeze({ type: 'string', pattern: API_POOL_ID_PATTERN }),
          displayName: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }),
          locationType: enumSchema(POOL_LOCATION_TYPES),
          webAppPoolId: Object.freeze({
            type: ['string', 'null'],
            pattern: API_POOL_ID_PATTERN,
          }),
          operating: Object.freeze({ $ref: '#/$defs/operating' }),
          maintenance: datumSchema(Object.freeze({
            type: 'array',
            items: enumSchema(POOL_MAINTENANCE_COMPONENTS),
            uniqueItems: true,
          })),
          capacity: objectSchema(
            ['attendance', 'maximumCapacity', 'remainingCapacity', 'utilizationPercent'],
            {
              attendance: nonNegativeDatum,
              maximumCapacity: nonNegativeDatum,
              remainingCapacity: nonNegativeDatum,
              utilizationPercent: nonNegativeDatum,
            },
          ),
          sourceReportedAt: instantSchema(),
        },
      ),
      operating: objectSchema(
        ['access', 'activity', 'closureKind', 'availableAreas'],
        {
          access: enumSchema(POOL_ACCESS_VALUES),
          activity: enumSchema(POOL_ACTIVITY_VALUES),
          closureKind: enumSchema(POOL_CLOSURE_KINDS),
          availableAreas: Object.freeze({
            type: 'array',
            items: enumSchema(POOL_AREAS),
            uniqueItems: true,
          }),
        },
      ),
    }),
  });
}

function publicApiResponsesSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${SCHEMA_BASE_ID}public-api-responses.schema.json`,
    title: 'Public API response bodies',
    description: 'The response schemas embedded in the generated OpenAPI contract.',
    oneOf: Object.freeze([
      'PoolsResponse',
      'PoolResponse',
      'ClosuresResponse',
      'HealthResponse',
      'ReadinessResponse',
      'ProblemDetails',
      'OpenApiDocument',
    ].map((name) => Object.freeze({ $ref: `#/components/schemas/${name}` }))),
    components: Object.freeze({ schemas: OPENAPI_COMPONENTS.schemas }),
  });
}

function datumSchema(
  valueSchema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    oneOf: Object.freeze([
      objectSchema(['state', 'value'], {
        state: Object.freeze({ type: 'string', const: 'available' }),
        value: valueSchema,
      }),
      objectSchema(['state'], {
        state: Object.freeze({ type: 'string', const: 'unavailable' }),
      }),
    ]),
  });
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    required: Object.freeze([...required]),
    properties: Object.freeze(properties),
    additionalProperties: false,
  });
}

function enumSchema(values: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: 'string', enum: Object.freeze([...values]) });
}

function nullableSourceString(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: ['string', 'null'],
    minLength: 1,
    maxLength: 256,
    pattern: SAFE_SOURCE_STRING_PATTERN,
  });
}

function nullableNumber(): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: ['number', 'null'] });
}

function instantSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: 'string', format: 'date-time' });
}
