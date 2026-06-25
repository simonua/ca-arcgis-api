import {
  createOpenApiOptionsResponses,
  createOpenApiQueryParameters,
  createOpenApiResponses,
  type DocumentedApiEndpointId,
  OPENAPI_COMPONENTS,
  withoutOpenApiResponseContent,
} from './openapi-contract.ts';

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
  readonly methods: readonly ['GET', 'HEAD', 'OPTIONS'];
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
    const responses = createOpenApiResponses(descriptor.id satisfies DocumentedApiEndpointId);
    const parameters = endpointParameters(descriptor.id);
    paths[descriptor.path] = Object.freeze({
      get: operation(descriptor, parameters, responses),
      head: operation(descriptor, parameters, withoutOpenApiResponseContent(responses), 'Head'),
      options: Object.freeze({
        operationId: `${descriptor.id}Options`,
        summary: `Get options for ${descriptor.summary.toLowerCase()}`,
        tags: descriptor.tags,
        responses: createOpenApiOptionsResponses(),
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
    security: Object.freeze([]),
    paths: Object.freeze(paths),
    components: OPENAPI_COMPONENTS,
  });
}

function endpointParameters(
  id: DocumentedApiEndpointId,
): readonly Readonly<Record<string, unknown>>[] {
  const pathParameters = id === 'getPool'
    ? [Object.freeze({
      name: 'poolId',
      in: 'path',
      required: true,
      description: 'Lowercase application-owned pool identifier.',
      schema: Object.freeze({
        type: 'string',
        pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
      }),
    })]
    : [];
  const queryParameters = id === 'listPools' || id === 'listClosures'
    ? createOpenApiQueryParameters()
    : [];
  return Object.freeze([...pathParameters, ...queryParameters]);
}

function operation(
  descriptor: ApiEndpointDescriptor,
  parameters: readonly Readonly<Record<string, unknown>>[],
  responses: Readonly<Record<string, unknown>>,
  operationSuffix = '',
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operationId: `${descriptor.id}${operationSuffix}`,
    summary: operationSuffix === '' ? descriptor.summary : `${descriptor.summary} without a body`,
    tags: descriptor.tags,
    ...(parameters.length === 0 ? {} : { parameters }),
    responses,
  });
}

function endpoint(
  id: ApiEndpointId,
  path: string,
  summary: string,
  tags: readonly string[],
): ApiEndpointDescriptor {
  return Object.freeze({
    id,
    methods: Object.freeze(['GET', 'HEAD', 'OPTIONS'] as const),
    path,
    summary,
    successStatus: 200,
    tags: Object.freeze([...tags]),
  });
}
