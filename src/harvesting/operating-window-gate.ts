export interface SourceAccessWindow {
  readonly startsAtEpochMs: number;
  readonly endsAtEpochMs: number;
}

export type OperatingWindowConfigurationErrorCode =
  | 'invalid-boundary'
  | 'invalid-order'
  | 'overlapping-windows';

export interface OperatingWindowConfigurationError {
  readonly code: OperatingWindowConfigurationErrorCode;
  readonly windowIndex: number;
}

export type OperatingWindowDecision =
  | Readonly<{ allowed: true; closesAtEpochMs: number }>
  | Readonly<{
    allowed: false;
    reason: 'closed' | 'invalid-time';
    nextOpensAtEpochMs?: number;
  }>;

export interface OperatingWindowGate {
  evaluate(nowEpochMs: number): OperatingWindowDecision;
}

export type OperatingWindowGateResult =
  | Readonly<{ ok: true; gate: OperatingWindowGate }>
  | Readonly<{ ok: false; error: OperatingWindowConfigurationError }>;

/** Validates exact UTC source-access instants and creates a fail-closed lookup gate. */
export function createOperatingWindowGate(
  sourceWindows: readonly SourceAccessWindow[],
): OperatingWindowGateResult {
  const windows: SourceAccessWindow[] = [];

  for (const [windowIndex, window] of sourceWindows.entries()) {
    if (!isEpochMs(window.startsAtEpochMs) || !isEpochMs(window.endsAtEpochMs)) {
      return configurationFailure('invalid-boundary', windowIndex);
    }
    if (window.startsAtEpochMs >= window.endsAtEpochMs) {
      return configurationFailure('invalid-order', windowIndex);
    }

    const previousWindow = windows.at(-1);
    if (previousWindow !== undefined && window.startsAtEpochMs < previousWindow.endsAtEpochMs) {
      return configurationFailure('overlapping-windows', windowIndex);
    }

    windows.push(Object.freeze({
      startsAtEpochMs: window.startsAtEpochMs,
      endsAtEpochMs: window.endsAtEpochMs,
    }));
  }

  const immutableWindows = Object.freeze(windows);
  return Object.freeze({
    ok: true,
    gate: Object.freeze({
      evaluate(nowEpochMs: number): OperatingWindowDecision {
        if (!isEpochMs(nowEpochMs)) {
          return Object.freeze({ allowed: false, reason: 'invalid-time' });
        }

        for (const window of immutableWindows) {
          if (nowEpochMs < window.startsAtEpochMs) {
            return Object.freeze({
              allowed: false,
              reason: 'closed',
              nextOpensAtEpochMs: window.startsAtEpochMs,
            });
          }
          if (nowEpochMs < window.endsAtEpochMs) {
            return Object.freeze({ allowed: true, closesAtEpochMs: window.endsAtEpochMs });
          }
        }

        return Object.freeze({ allowed: false, reason: 'closed' });
      },
    }),
  });
}

function configurationFailure(
  code: OperatingWindowConfigurationErrorCode,
  windowIndex: number,
): OperatingWindowGateResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, windowIndex }) });
}

function isEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
