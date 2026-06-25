import { API_REPRESENTATION_FILTER_VALUES } from '../cache/api-representation-cache.ts';

export type DocumentedApiEndpointId =
  | 'listPools'
  | 'getPool'
  | 'listClosures'
  | 'health'
  | 'readiness'
  | 'openApi';

export const API_FILTER_VALUES = API_REPRESENTATION_FILTER_VALUES;

const SCHEMA_REF = '#/components/schemas/';
const HEADER_REF = '#/components/headers/';
const JSON_CONTENT = 'application/json';
const PROBLEM_CONTENT = 'application/problem+json';

export const OPENAPI_COMPONENTS = Object.freeze({
  schemas: Object.freeze({
    Snapshot: objectSchema(
      ['lastCheckedAt', 'state', 'collectionState'],
      {
        lastCheckedAt: instant('Time of the most recent completed source check.'),
        state: enumSchema(API_FILTER_VALUES.dataState, 'Aggregate snapshot freshness.'),
        collectionState: enumSchema(
          ['active', 'paused-closed-hours'],
          'Current scheduler operating-window state.',
        ),
        nextSourceAccessAt: instant('Earliest known instant when source access may resume.'),
      },
      {
        lastCheckedAt: '2026-06-25T15:05:00.000Z',
        state: 'current',
        collectionState: 'active',
      },
    ),
    PoolOperating: objectSchema(
      ['access', 'activity', 'closureKind', 'availableAreas'],
      {
        access: enumSchema(API_FILTER_VALUES.access, 'Normalized visitor access state.'),
        activity: enumSchema(
          [
            'rec-swim',
            'adult-laps',
            'swim-lessons',
            'aqua-fit',
            'senior-swim',
            'special-event',
            'none',
          ],
          'Normalized current activity.',
        ),
        closureKind: enumSchema(API_FILTER_VALUES.closureKind, 'Normalized closure reason.'),
        availableAreas: Object.freeze({
          type: 'array',
          description: 'Normalized pool areas that remain available.',
          items: enumSchema(['main-pool', 'baby-pool', 'program-pool']),
          uniqueItems: true,
        }),
      },
    ),
    PoolMaintenance: objectSchema(
      ['affectedComponents'],
      {
        affectedComponents: Object.freeze({
          type: 'array',
          description: 'Normalized components affected by maintenance.',
          items: enumSchema([
            'wading-pool',
            'spa',
            'slide',
            'splashpad',
            'non-pool-amenities',
            'main-pool',
          ]),
          uniqueItems: true,
        }),
      },
    ),
    PoolOccupancy: objectSchema(
      ['attendance', 'maximumCapacity', 'remainingCapacity', 'utilizationPercent'],
      {
        attendance: nullableNumber('Current attendance when semantically current.'),
        maximumCapacity: nullableNumber('Accepted maximum capacity when available.'),
        remainingCapacity: nullableNumber('Derived remaining capacity when available.'),
        utilizationPercent: nullableNumber('Derived utilization percentage when available.'),
      },
    ),
    Pool: objectSchema(
      [
        'id',
        'webAppPoolId',
        'name',
        'locationType',
        'dataState',
        'reportedAt',
        'operating',
        'maintenance',
        'occupancy',
      ],
      {
        id: poolIdSchema(),
        webAppPoolId: Object.freeze({
          type: ['string', 'null'],
          description: 'Approved identifier used by the consuming web application.',
        }),
        name: Object.freeze({ type: 'string', minLength: 1 }),
        locationType: enumSchema(API_FILTER_VALUES.locationType),
        dataState: enumSchema(API_FILTER_VALUES.dataState),
        reportedAt: instant('Time represented by the source record, not the collection time.'),
        operating: nullableReference('PoolOperating'),
        maintenance: nullableReference('PoolMaintenance'),
        occupancy: reference('PoolOccupancy'),
      },
      {
        id: 'river-hill',
        webAppPoolId: 'rh',
        name: 'River Hill Pool',
        locationType: 'outdoor',
        dataState: 'current',
        reportedAt: '2026-06-25T15:02:18.757Z',
        operating: {
          access: 'open-public',
          activity: 'rec-swim',
          closureKind: 'none',
          availableAreas: [],
        },
        maintenance: { affectedComponents: [] },
        occupancy: {
          attendance: 120,
          maximumCapacity: 384,
          remainingCapacity: 264,
          utilizationPercent: 31.25,
        },
      },
    ),
    PoolsResponse: responseEnvelope(
      'pools',
      Object.freeze({
        type: 'array',
        items: reference('Pool'),
      }),
    ),
    PoolResponse: responseEnvelope('pool', reference('Pool')),
    ClosuresResponse: responseEnvelope(
      'closures',
      Object.freeze({
        type: 'array',
        items: reference('Pool'),
      }),
    ),
    HealthResponse: objectSchema(
      ['status'],
      { status: Object.freeze({ type: 'string', const: 'live' }) },
      { status: 'live' },
    ),
    ReadinessResponse: objectSchema(
      ['status', 'snapshotState', 'collectionState', 'lastCheckedAt'],
      {
        status: enumSchema(['ready', 'degraded']),
        snapshotState: enumSchema(API_FILTER_VALUES.dataState),
        collectionState: enumSchema(['active', 'paused-closed-hours']),
        lastCheckedAt: instant('Time of the most recent completed source check.'),
        nextSourceAccessAt: instant('Earliest known instant when source access may resume.'),
      },
      {
        status: 'degraded',
        snapshotState: 'degraded',
        collectionState: 'paused-closed-hours',
        lastCheckedAt: '2026-06-25T15:05:00.000Z',
        nextSourceAccessAt: '2026-06-26T10:00:00.000Z',
      },
    ),
    ProblemDetails: objectSchema(
      ['type', 'title', 'status', 'detail', 'instance', 'code'],
      {
        type: Object.freeze({ type: 'string', format: 'uri' }),
        title: Object.freeze({ type: 'string', minLength: 1 }),
        status: Object.freeze({ type: 'integer', minimum: 400, maximum: 599 }),
        detail: Object.freeze({ type: 'string', minLength: 1 }),
        instance: Object.freeze({ type: 'string', pattern: '^/' }),
        code: enumSchema([
          'client_rate_limited',
          'internal_error',
          'invalid_filter',
          'invalid_request',
          'method_not_allowed',
          'not_acceptable',
          'pool_not_found',
          'route_not_found',
          'snapshot_unavailable',
          'unsupported_media_type',
        ]),
        nextSourceAccessAt: instant('Earliest known instant when source access may resume.'),
      },
      {
        type: 'https://api.pools.longreachmarlins.org/problems/invalid_filter',
        title: 'Bad Request',
        status: 400,
        detail: 'A query filter is unknown or invalid.',
        instance: '/v1/pools',
        code: 'invalid_filter',
      },
    ),
    OpenApiDocument: Object.freeze({
      type: 'object',
      description: 'The deterministic OpenAPI 3.1 discovery document.',
      required: Object.freeze(['openapi', 'info', 'paths']),
      additionalProperties: true,
    }),
  }),
  headers: Object.freeze({
    CacheControl: header('Caching policy for this representation.', { type: 'string' }),
    ETag: header('Strong validator for this normalized representation.', { type: 'string' }),
    RetryAfter: header('Seconds before the client should retry.', {
      type: 'integer',
      minimum: 0,
    }),
    Allow: header('Methods supported by this endpoint.', {
      type: 'string',
      const: 'GET, HEAD, OPTIONS',
    }),
  }),
});

export function createOpenApiQueryParameters(): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(
    Object.entries(API_FILTER_VALUES).map(([name, values]) =>
      Object.freeze({
        name,
        in: 'query',
        required: false,
        description: `Exact allowlisted ${name} value. The parameter may appear at most once.`,
        schema: enumSchema(values),
      })
    ),
  );
}

export function createOpenApiResponses(
  endpointId: DocumentedApiEndpointId,
): Readonly<Record<string, unknown>> {
  const responses: Record<string, unknown> = {
    '200': successResponse(endpointId),
    '400': problemResponse('The request or query filters are invalid.'),
    '405': problemResponse('The method is not allowed for this route.', {
      Allow: headerReference('Allow'),
    }),
    '406': problemResponse('The requested response media type is not supported.'),
    '415': problemResponse('This read-only endpoint does not accept a request body.'),
  };
  if (endpointId === 'getPool') {
    responses['404'] = problemResponse('The requested pool identifier is unknown.');
  }
  if (endpointId === 'listPools' || endpointId === 'getPool' || endpointId === 'listClosures') {
    responses['304'] = Object.freeze({
      description: 'The normalized representation has not changed.',
      headers: publicDataHeaders(),
    });
    responses['429'] = rateLimitedResponse();
    responses['500'] = problemResponse('The request could not be completed.');
    responses['503'] = unavailableResponse();
  } else if (endpointId === 'readiness') {
    responses['500'] = problemResponse('The readiness projection could not be completed.');
    responses['503'] = unavailableResponse();
  } else if (endpointId === 'openApi') {
    responses['429'] = rateLimitedResponse();
  }
  return Object.freeze(responses);
}

export function createOpenApiOptionsResponses(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    '204': Object.freeze({
      description: 'The endpoint options and CORS preflight policy.',
      headers: Object.freeze({
        Allow: headerReference('Allow'),
        'Access-Control-Allow-Methods': header(
          'Methods accepted by the endpoint.',
          { type: 'string', const: 'GET, HEAD, OPTIONS' },
        ),
        'Access-Control-Allow-Headers': header(
          'Request headers accepted by CORS preflight.',
          { type: 'string', const: 'Accept, If-None-Match' },
        ),
        'Access-Control-Max-Age': header('Seconds the preflight result may be cached.', {
          type: 'integer',
          minimum: 0,
        }),
      }),
    }),
    '400': problemResponse('The preflight request is malformed or requests unsupported headers.'),
    '406': problemResponse('The requested response media type is not supported.'),
    '415': problemResponse('This read-only endpoint does not accept a request body.'),
  });
}

export function withoutOpenApiResponseContent(
  responses: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      const { content: _content, ...metadata } = response as Readonly<Record<string, unknown>>;
      return [status, Object.freeze(metadata)];
    }),
  ));
}

function successResponse(endpointId: DocumentedApiEndpointId): Readonly<Record<string, unknown>> {
  const schemaName = {
    listPools: 'PoolsResponse',
    getPool: 'PoolResponse',
    listClosures: 'ClosuresResponse',
    health: 'HealthResponse',
    readiness: 'ReadinessResponse',
    openApi: 'OpenApiDocument',
  }[endpointId];
  const publicData = endpointId === 'listPools' || endpointId === 'getPool' ||
    endpointId === 'listClosures';
  return Object.freeze({
    description: 'Successful response.',
    headers: publicData
      ? publicDataHeaders()
      : Object.freeze({ CacheControl: headerReference('CacheControl') }),
    content: Object.freeze({
      [JSON_CONTENT]: Object.freeze({ schema: reference(schemaName) }),
    }),
  });
}

function problemResponse(
  description: string,
  headers: Readonly<Record<string, unknown>> = Object.freeze({}),
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    description,
    headers: Object.freeze({ CacheControl: headerReference('CacheControl'), ...headers }),
    content: Object.freeze({
      [PROBLEM_CONTENT]: Object.freeze({ schema: reference('ProblemDetails') }),
    }),
  });
}

function unavailableResponse(): Readonly<Record<string, unknown>> {
  return problemResponse('No serviceable in-memory snapshot is available.', {
    RetryAfter: headerReference('RetryAfter'),
  });
}

function rateLimitedResponse(): Readonly<Record<string, unknown>> {
  return problemResponse('The client request limit was exceeded.', {
    RetryAfter: headerReference('RetryAfter'),
  });
}

function publicDataHeaders(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    CacheControl: headerReference('CacheControl'),
    ETag: headerReference('ETag'),
  });
}

function responseEnvelope(
  payloadName: string,
  payloadSchema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return objectSchema(
    ['apiVersion', 'snapshot', payloadName],
    {
      apiVersion: Object.freeze({ type: 'string', const: '1' }),
      snapshot: reference('Snapshot'),
      [payloadName]: payloadSchema,
    },
  );
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
  example?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    required: Object.freeze([...required]),
    properties: Object.freeze(properties),
    additionalProperties: false,
    ...(example === undefined ? {} : { example: Object.freeze(example) }),
  });
}

function enumSchema(
  values: readonly string[],
  description?: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'string',
    enum: Object.freeze([...values]),
    ...(description === undefined ? {} : { description }),
  });
}

function instant(description: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: 'string', format: 'date-time', description });
}

function nullableNumber(description: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: ['number', 'null'], minimum: 0, description });
}

function poolIdSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'string',
    description: 'Lowercase application-owned pool identifier.',
    pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
  });
}

function reference(schemaName: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ $ref: `${SCHEMA_REF}${schemaName}` });
}

function nullableReference(schemaName: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    anyOf: Object.freeze([
      reference(schemaName),
      Object.freeze({ type: 'null' }),
    ]),
  });
}

function header(
  description: string,
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ description, schema: Object.freeze(schema) });
}

function headerReference(headerName: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ $ref: `${HEADER_REF}${headerName}` });
}
