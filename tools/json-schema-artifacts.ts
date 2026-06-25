import {
  JSON_SCHEMA_ARTIFACTS,
  type JsonSchemaArtifactName,
} from '../src/contracts/json-schema-contracts.ts';

const SCHEMA_DIRECTORY = new URL('../schemas/', import.meta.url);
const mode = Deno.args[0];

if (mode !== 'write' && mode !== 'check') {
  throw new Error('Usage: deno run tools/json-schema-artifacts.ts <write|check>');
}

for (
  const [name, schema] of Object.entries(JSON_SCHEMA_ARTIFACTS) as Array<
    [JsonSchemaArtifactName, Readonly<Record<string, unknown>>]
  >
) {
  const target = new URL(name, SCHEMA_DIRECTORY);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  if (mode === 'write') {
    await Deno.writeTextFile(target, expected);
    continue;
  }

  let actual: string;
  try {
    actual = await Deno.readTextFile(target);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Generated schema is missing: ${name}`);
    }
    throw error;
  }
  if (actual !== expected) {
    throw new Error(`Generated schema is stale: ${name}`);
  }
}
