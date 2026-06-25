import type { MonotonicPermitGate } from './monotonic-permit-gate.ts';
import type { OperatingWindowGate } from './operating-window-gate.ts';

export interface SourceGateClock {
  nowEpochMs(): number;
  nowMonotonicMs(): number;
}

export interface SourceOperationLease {
  release(): void;
}

export interface SourceOperationLock {
  tryAcquire(): SourceOperationLease | undefined;
}

export type SourceSendDeniedReason =
  | 'invalid-monotonic-time'
  | 'invalid-wall-time'
  | 'operation-in-progress'
  | 'outside-operating-window'
  | 'permit-unavailable';

export type SourceSendResult<T> =
  | Readonly<{ status: 'sent'; value: T }>
  | Readonly<{
    status: 'denied';
    reason: SourceSendDeniedReason;
    nextAllowedAtMonotonicMs?: number;
    nextOpensAtEpochMs?: number;
  }>;

export interface SourceSendGateDependencies {
  readonly clock: SourceGateClock;
  readonly operatingWindowGate: OperatingWindowGate;
  readonly permitGate: MonotonicPermitGate;
  readonly operationLock: SourceOperationLock;
}

/** Creates one shared non-queuing lock for all ArcGIS source operations. */
export function createSourceOperationLock(): SourceOperationLock {
  let held = false;

  return Object.freeze({
    tryAcquire(): SourceOperationLease | undefined {
      if (held) {
        return undefined;
      }

      held = true;
      let released = false;
      return Object.freeze({
        release(): void {
          if (!released) {
            released = true;
            held = false;
          }
        },
      });
    },
  });
}

/** Runs an injected sender only after every outbound safety gate grants permission. */
export async function executeGatedSourceSend<T>(
  dependencies: SourceSendGateDependencies,
  send: () => Promise<T>,
): Promise<SourceSendResult<T>> {
  const initialWindow = dependencies.operatingWindowGate.evaluate(
    dependencies.clock.nowEpochMs(),
  );
  if (!initialWindow.allowed) {
    return windowDenial(initialWindow);
  }

  const lease = dependencies.operationLock.tryAcquire();
  if (lease === undefined) {
    return Object.freeze({ status: 'denied', reason: 'operation-in-progress' });
  }

  try {
    const permit = dependencies.permitGate.acquire(dependencies.clock.nowMonotonicMs());
    if (!permit.granted) {
      if (permit.reason === 'invalid-time') {
        return permit.nextAllowedAtMonotonicMs === undefined
          ? Object.freeze({ status: 'denied', reason: 'invalid-monotonic-time' })
          : Object.freeze({
            status: 'denied',
            reason: 'invalid-monotonic-time',
            nextAllowedAtMonotonicMs: permit.nextAllowedAtMonotonicMs,
          });
      }
      return Object.freeze({
        status: 'denied',
        reason: 'permit-unavailable',
        nextAllowedAtMonotonicMs: permit.nextAllowedAtMonotonicMs,
      });
    }

    const finalWindow = dependencies.operatingWindowGate.evaluate(
      dependencies.clock.nowEpochMs(),
    );
    if (!finalWindow.allowed) {
      return windowDenial(finalWindow);
    }

    return Object.freeze({ status: 'sent', value: await send() });
  } finally {
    lease.release();
  }
}

function windowDenial(
  decision: Exclude<ReturnType<OperatingWindowGate['evaluate']>, { allowed: true }>,
): SourceSendResult<never> {
  const reason = decision.reason === 'invalid-time'
    ? 'invalid-wall-time'
    : 'outside-operating-window';
  return decision.nextOpensAtEpochMs === undefined
    ? Object.freeze({ status: 'denied', reason })
    : Object.freeze({
      status: 'denied',
      reason,
      nextOpensAtEpochMs: decision.nextOpensAtEpochMs,
    });
}
