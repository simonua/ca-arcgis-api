export type ApiProblemCode =
  | 'client_rate_limited'
  | 'internal_error'
  | 'invalid_filter'
  | 'invalid_request'
  | 'method_not_allowed'
  | 'not_acceptable'
  | 'pool_not_found'
  | 'route_not_found'
  | 'snapshot_unavailable'
  | 'unsupported_media_type';

export interface ApiProblemOptions {
  readonly code: ApiProblemCode;
  readonly instance: string;
  readonly head?: boolean;
  readonly headers?: Headers;
  readonly retryAfterSeconds?: number;
  readonly nextSourceAccessAt?: string;
}

interface ProblemDefinition {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}

const PROBLEMS: Readonly<Record<ApiProblemCode, ProblemDefinition>> = Object.freeze({
  client_rate_limited: problem(429, 'Too Many Requests', 'The client request limit was exceeded.'),
  internal_error: problem(500, 'Internal Server Error', 'The request could not be completed.'),
  invalid_filter: problem(400, 'Bad Request', 'A query filter is unknown or invalid.'),
  invalid_request: problem(
    400,
    'Bad Request',
    'The request is malformed or exceeds service limits.',
  ),
  method_not_allowed: problem(
    405,
    'Method Not Allowed',
    'The method is not allowed for this route.',
  ),
  not_acceptable: problem(
    406,
    'Not Acceptable',
    'The requested response media type is not supported.',
  ),
  pool_not_found: problem(404, 'Not Found', 'The requested pool does not exist.'),
  route_not_found: problem(404, 'Not Found', 'The requested route does not exist.'),
  snapshot_unavailable: problem(
    503,
    'Service Unavailable',
    'No serviceable pool snapshot is available.',
  ),
  unsupported_media_type: problem(
    415,
    'Unsupported Media Type',
    'This read-only endpoint does not accept a request body.',
  ),
});

/** Creates a bounded RFC 9457 response without reflecting untrusted request values. */
export function createProblemResponse(options: ApiProblemOptions): Response {
  const definition = PROBLEMS[options.code];
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/problem+json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  if (options.retryAfterSeconds !== undefined) {
    headers.set('retry-after', String(options.retryAfterSeconds));
  }

  const serialized = JSON.stringify({
    type: `https://api.pools.longreachmarlins.org/problems/${options.code}`,
    title: definition.title,
    status: definition.status,
    detail: definition.detail,
    instance: options.instance,
    code: options.code,
    ...(options.nextSourceAccessAt === undefined
      ? {}
      : { nextSourceAccessAt: options.nextSourceAccessAt }),
  });
  const body = new TextEncoder().encode(serialized);
  headers.set('content-length', String(body.byteLength));
  return new Response(options.head ? null : body, { status: definition.status, headers });
}

function problem(status: number, title: string, detail: string): ProblemDefinition {
  return Object.freeze({ status, title, detail });
}
