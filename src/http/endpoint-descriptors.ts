export const API_VERSION = '1' as const;

export type ApiEndpointId =
  | 'listPools'
  | 'getPool'
  | 'listClosures'
  | 'health'
  | 'readiness'
  | 'openApi'
  | 'swagger';

export interface ApiEndpointDescriptor {
  readonly id: ApiEndpointId;
  readonly path: string;
  readonly summary: string;
  readonly successStatus: 200;
  readonly tags: readonly string[];
}

export interface MatchedApiEndpoint {
  readonly descriptor: ApiEndpointDescriptor;
  readonly poolId?: string;
}

export const API_ENDPOINTS: readonly ApiEndpointDescriptor[] = Object.freeze([
  endpoint('listPools', '/v1/pools', 'List configured pools', ['Pools']),
  endpoint('getPool', '/v1/pools/{poolId}', 'Get one configured pool', ['Pools']),
  endpoint('listClosures', '/v1/closures', 'List current or stale closures', ['Closures']),
  endpoint('health', '/healthz', 'Check process liveness', ['Operations']),
  endpoint('readiness', '/readyz', 'Check snapshot readiness', ['Operations']),
  endpoint('openApi', '/openapi/v1.json', 'Get the OpenAPI contract', ['Discovery']),
  endpoint('swagger', '/swagger', 'Open the interactive API tester', ['Discovery']),
]);

const FIXED_ENDPOINTS = new Map(
  API_ENDPOINTS.filter((descriptor) => !descriptor.path.includes('{')).map((descriptor) => [
    descriptor.path,
    descriptor,
  ]),
);
const POOL_ENDPOINT = API_ENDPOINTS.find((descriptor) => descriptor.id === 'getPool');

/** Matches only canonical, allowlisted API paths. */
export function matchApiEndpoint(pathname: string): MatchedApiEndpoint | undefined {
  const fixed = FIXED_ENDPOINTS.get(pathname);
  if (fixed !== undefined) {
    return Object.freeze({ descriptor: fixed });
  }

  if (POOL_ENDPOINT === undefined || !pathname.startsWith('/v1/pools/')) {
    return undefined;
  }
  const encodedPoolId = pathname.slice('/v1/pools/'.length);
  if (encodedPoolId.length === 0 || encodedPoolId.includes('/')) {
    return undefined;
  }
  try {
    const poolId = decodeURIComponent(encodedPoolId);
    return Object.freeze({ descriptor: POOL_ENDPOINT, poolId });
  } catch {
    return undefined;
  }
}

/** Builds the discovery document from the same endpoint descriptors used by routing. */
export function createOpenApiDocument(): Readonly<Record<string, unknown>> {
  const paths: Record<string, unknown> = {};
  for (const descriptor of API_ENDPOINTS) {
    if (descriptor.id === 'swagger') {
      continue;
    }
    paths[descriptor.path] = Object.freeze({
      get: Object.freeze({
        operationId: descriptor.id,
        summary: descriptor.summary,
        tags: descriptor.tags,
        ...(descriptor.id === 'getPool'
          ? {
            parameters: Object.freeze([
              Object.freeze({
                name: 'poolId',
                in: 'path',
                required: true,
                description: 'Lowercase application-owned pool identifier.',
                schema: Object.freeze({
                  type: 'string',
                  pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
                }),
              }),
            ]),
          }
          : {}),
        responses: Object.freeze({
          [String(descriptor.successStatus)]: Object.freeze({
            description: 'Successful response.',
          }),
          ...(descriptor.id === 'health' || descriptor.id === 'readiness' ? {} : {
            '429': Object.freeze({ description: 'Client request limit exceeded.' }),
          }),
          ...(descriptor.id === 'health' || descriptor.id === 'openApi' ? {} : {
            '503': Object.freeze({ description: 'No serviceable snapshot is available.' }),
          }),
        }),
      }),
    });
  }

  return Object.freeze({
    openapi: '3.1.0',
    info: Object.freeze({
      title: 'CA Pool Status API',
      version: API_VERSION,
      description: 'Read-only normalized pool status snapshots.',
    }),
    paths: Object.freeze(paths),
  });
}

function endpoint(
  id: ApiEndpointId,
  path: string,
  summary: string,
  tags: readonly string[],
): ApiEndpointDescriptor {
  return Object.freeze({ id, path, summary, successStatus: 200, tags: Object.freeze([...tags]) });
}
