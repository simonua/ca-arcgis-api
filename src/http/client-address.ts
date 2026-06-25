export const UNKNOWN_CLIENT_ADDRESS = 'unknown' as const;

/** Resolves ACA's trusted rightmost forwarding hop, failing closed to one shared partition. */
export function resolveClientAddress(
  forwardedFor: string | null,
  fallbackRemoteAddress?: string,
): string {
  if (forwardedFor !== null) {
    const rightmost = forwardedFor.split(',').at(-1)?.trim();
    return rightmost !== undefined && isIpAddress(rightmost)
      ? normalizeAddress(rightmost)
      : UNKNOWN_CLIENT_ADDRESS;
  }
  return fallbackRemoteAddress !== undefined && isIpAddress(fallbackRemoteAddress)
    ? normalizeAddress(fallbackRemoteAddress)
    : UNKNOWN_CLIENT_ADDRESS;
}

function isIpAddress(value: string): boolean {
  if (value.length === 0 || value.length > 45 || value !== value.trim()) {
    return false;
  }
  return isIpv4(value) || isIpv6(value);
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) {
      return false;
    }
    return Number(part) <= 255;
  });
}

function isIpv6(value: string): boolean {
  if (!value.includes(':') || value.includes('[') || value.includes(']') || value.includes('%')) {
    return false;
  }
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function normalizeAddress(value: string): string {
  if (!value.includes(':')) {
    return value;
  }
  const hostname = new URL(`http://[${value}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}
