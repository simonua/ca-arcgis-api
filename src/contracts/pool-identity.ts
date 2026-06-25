const POOL_API_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Narrows application-owned lowercase pool identifiers used in routes and cache keys. */
export function isPoolApiId(value: unknown): value is string {
  return typeof value === 'string' && POOL_API_ID_PATTERN.test(value);
}
