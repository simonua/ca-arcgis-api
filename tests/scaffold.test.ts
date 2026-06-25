import { SERVICE_NAME } from '../src/index.ts';

Deno.test('exports the stable service identity', () => {
  if (SERVICE_NAME !== 'ca-arcgis-api') {
    throw new Error(`Unexpected service identity: ${SERVICE_NAME}`);
  }
});
