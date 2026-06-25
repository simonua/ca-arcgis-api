import { ARCGIS_OUT_FIELDS } from '../src/contracts/arcgis-source.ts';
import { JSON_SCHEMA_ARTIFACTS } from '../src/contracts/json-schema-contracts.ts';
import {
  POOL_ACCESS_VALUES,
  POOL_ACTIVITY_VALUES,
  POOL_AREAS,
  POOL_CLOSURE_KINDS,
  POOL_LOCATION_TYPES,
  POOL_MAINTENANCE_COMPONENTS,
} from '../src/contracts/pool-snapshot.ts';
import { OPENAPI_COMPONENTS } from '../src/http/openapi-contract.ts';

Deno.test('generated source schema owns exactly the fixed ArcGIS field allowlist', () => {
  const schema = JSON_SCHEMA_ARTIFACTS['arcgis-source-response.schema.json'];
  const properties = nestedRecord(schema, '$defs', 'attributes', 'properties');

  assertEquals(Object.keys(properties).sort().join(','), [...ARCGIS_OUT_FIELDS].sort().join(','));
  assertEquals(nestedRecord(schema, 'properties').geometry, undefined);
});

Deno.test('generated snapshot schema shares canonical normalized vocabulary', () => {
  const schemaText = JSON.stringify(JSON_SCHEMA_ARTIFACTS['pool-snapshot.schema.json']);
  for (
    const value of [
      ...POOL_LOCATION_TYPES,
      ...POOL_ACCESS_VALUES,
      ...POOL_ACTIVITY_VALUES,
      ...POOL_CLOSURE_KINDS,
      ...POOL_AREAS,
      ...POOL_MAINTENANCE_COMPONENTS,
    ]
  ) {
    assert(schemaText.includes(JSON.stringify(value)), `Expected snapshot schema value ${value}`);
  }
  assertEquals(schemaText.includes('AssetID'), false);
  assertEquals(schemaText.includes('Pool_Attendance'), false);
});

Deno.test('generated public response schema embeds the OpenAPI semantic owner', () => {
  const schema = JSON_SCHEMA_ARTIFACTS['public-api-responses.schema.json'];
  const components = nestedRecord(schema, 'components', 'schemas');

  assertSame(components, OPENAPI_COMPONENTS.schemas);
  const schemaText = JSON.stringify(schema);
  assertEquals(schemaText.includes('AssetID'), false);
  assertEquals(schemaText.includes('EditDate'), false);
  assertEquals(schemaText.includes('Pool_Capacity'), false);
});

function nestedRecord(
  value: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): Readonly<Record<string, unknown>> {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(`Expected object at ${segment}`);
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error('Expected nested record');
  }
  return current as Readonly<Record<string, unknown>>;
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
