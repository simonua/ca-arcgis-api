export const MIN_COLLECTION_INTERVAL_MS = 300_000 as const;

export type MonotonicPermitConfigurationErrorCode =
  | 'interval-below-minimum'
  | 'invalid-interval';

export type MonotonicPermitDecision =
  | Readonly<{ granted: true; nextAllowedAtMonotonicMs: number }>
  | Readonly<{
    granted: false;
    reason: 'invalid-time';
    nextAllowedAtMonotonicMs?: number;
  }>
  | Readonly<{
    granted: false;
    reason: 'permit-unavailable';
    nextAllowedAtMonotonicMs: number;
  }>;

export interface MonotonicPermitGate {
  acquire(nowMonotonicMs: number): MonotonicPermitDecision;
}

export type MonotonicPermitGateResult =
  | Readonly<{ ok: true; gate: MonotonicPermitGate }>
  | Readonly<{
    ok: false;
    error: Readonly<{ code: MonotonicPermitConfigurationErrorCode }>;
  }>;

/** Creates a capacity-one permit gate with no burst accumulation. */
export function createMonotonicPermitGate(intervalMs: number): MonotonicPermitGateResult {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    return permitConfigurationFailure('invalid-interval');
  }
  if (intervalMs < MIN_COLLECTION_INTERVAL_MS) {
    return permitConfigurationFailure('interval-below-minimum');
  }

  let nextAllowedAtMonotonicMs: number | undefined;
  const gate: MonotonicPermitGate = Object.freeze({
    acquire(nowMonotonicMs: number): MonotonicPermitDecision {
      if (!Number.isFinite(nowMonotonicMs) || nowMonotonicMs < 0) {
        return nextAllowedAtMonotonicMs === undefined
          ? Object.freeze({ granted: false, reason: 'invalid-time' })
          : Object.freeze({
            granted: false,
            reason: 'invalid-time',
            nextAllowedAtMonotonicMs,
          });
      }
      if (
        nextAllowedAtMonotonicMs !== undefined &&
        nowMonotonicMs < nextAllowedAtMonotonicMs
      ) {
        return Object.freeze({
          granted: false,
          reason: 'permit-unavailable',
          nextAllowedAtMonotonicMs,
        });
      }

      const nextDeadline = nowMonotonicMs + intervalMs;
      if (!Number.isFinite(nextDeadline)) {
        return Object.freeze({ granted: false, reason: 'invalid-time' });
      }

      nextAllowedAtMonotonicMs = nextDeadline;
      return Object.freeze({ granted: true, nextAllowedAtMonotonicMs: nextDeadline });
    },
  });

  return Object.freeze({ ok: true, gate });
}

function permitConfigurationFailure(
  code: MonotonicPermitConfigurationErrorCode,
): MonotonicPermitGateResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}
