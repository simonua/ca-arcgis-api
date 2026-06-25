import type {
  ArcGisClient,
  ArcGisCollectionRequest,
  ArcGisCollectionResult,
} from './arcgis-client.ts';
import type { DailyAttemptBudget } from './daily-attempt-budget.ts';
import type {
  CollectionResiliencePolicy,
  CollectionResilienceSchedule,
} from './collection-resilience.ts';
import type { OperatingWindowGate } from './operating-window-gate.ts';
import {
  executeGatedSourceSend,
  type SourceSendDeniedReason,
  type SourceSendGateDependencies,
} from './source-send-gate.ts';

export type CollectionCycleDeferredReason =
  | 'backoff'
  | 'circuit-half-open'
  | 'circuit-open'
  | 'daily-ceiling'
  | 'emergency-disabled'
  | 'invalid-time'
  | 'operation-in-progress'
  | 'operator-review'
  | 'outside-operating-window'
  | 'permit-unavailable'
  | 'poll-disabled'
  | 'retry-after';

export type CollectionCycleResult =
  | Readonly<{
    status: 'attempted';
    result: ArcGisCollectionResult;
    schedule: CollectionResilienceSchedule;
  }>
  | Readonly<{
    status: 'deferred';
    reason: CollectionCycleDeferredReason;
    nextAtEpochMs?: number;
    nextAtMonotonicMs?: number;
  }>;

export interface CollectionScheduler {
  runCycle(request?: ArcGisCollectionRequest): Promise<CollectionCycleResult>;
}

export interface CollectionSchedulerDependencies {
  readonly pollEnabled: boolean;
  readonly emergencyDisabled: () => boolean;
  readonly clock: SourceSendGateDependencies['clock'];
  readonly operatingWindowGate: OperatingWindowGate;
  readonly sourceSendGate: SourceSendGateDependencies;
  readonly dailyAttemptBudget: DailyAttemptBudget;
  readonly resiliencePolicy: CollectionResiliencePolicy;
  readonly client: ArcGisClient;
}

type BudgetedSendResult =
  | Readonly<{ attempted: true; result: ArcGisCollectionResult }>
  | Readonly<{ attempted: false; nextResetAtEpochMs?: number }>;

/** Coordinates one completion-based collection cycle without timers or hidden retries. */
export function createCollectionScheduler(
  dependencies: CollectionSchedulerDependencies,
): CollectionScheduler {
  return Object.freeze({
    async runCycle(request: ArcGisCollectionRequest = {}): Promise<CollectionCycleResult> {
      const nowEpochMs = dependencies.clock.nowEpochMs();
      const window = dependencies.operatingWindowGate.evaluate(nowEpochMs);
      if (!window.allowed) {
        return deferred(
          window.reason === 'invalid-time' ? 'invalid-time' : 'outside-operating-window',
          window.nextOpensAtEpochMs,
        );
      }
      if (!dependencies.pollEnabled) {
        return deferred('poll-disabled');
      }
      if (dependencies.emergencyDisabled()) {
        return deferred('emergency-disabled');
      }

      const budget = dependencies.dailyAttemptBudget.check(nowEpochMs);
      if (!budget.allowed) {
        return deferred(
          budget.reason === 'invalid-time' ? 'invalid-time' : 'daily-ceiling',
          budget.nextResetAtEpochMs,
        );
      }

      const acquired = dependencies.resiliencePolicy.acquire(
        nowEpochMs,
        dependencies.clock.nowMonotonicMs(),
      );
      if (!acquired.allowed) {
        return Object.freeze({
          status: 'deferred',
          reason: acquired.reason,
          ...(acquired.nextAtEpochMs === undefined
            ? {}
            : { nextAtEpochMs: acquired.nextAtEpochMs }),
          ...(acquired.nextAtMonotonicMs === undefined
            ? {}
            : { nextAtMonotonicMs: acquired.nextAtMonotonicMs }),
        });
      }

      const sendResult = await executeGatedSourceSend(
        dependencies.sourceSendGate,
        async (): Promise<BudgetedSendResult> => {
          const consumed = dependencies.dailyAttemptBudget.consume(
            dependencies.clock.nowEpochMs(),
          );
          if (!consumed.allowed) {
            return Object.freeze({
              attempted: false,
              ...(consumed.nextResetAtEpochMs === undefined
                ? {}
                : { nextResetAtEpochMs: consumed.nextResetAtEpochMs }),
            });
          }
          return Object.freeze({
            attempted: true,
            result: await dependencies.client.collect(request),
          });
        },
      );

      if (sendResult.status === 'denied') {
        dependencies.resiliencePolicy.cancel(
          acquired.mode,
          dependencies.clock.nowMonotonicMs(),
        );
        return mapSourceDenial(sendResult.reason, sendResult);
      }
      if (!sendResult.value.attempted) {
        dependencies.resiliencePolicy.cancel(
          acquired.mode,
          dependencies.clock.nowMonotonicMs(),
        );
        return deferred('daily-ceiling', sendResult.value.nextResetAtEpochMs);
      }

      const schedule = dependencies.resiliencePolicy.record(
        acquired.mode,
        sendResult.value.result,
        dependencies.clock.nowEpochMs(),
        dependencies.clock.nowMonotonicMs(),
      );
      return Object.freeze({
        status: 'attempted',
        result: sendResult.value.result,
        schedule,
      });
    },
  });
}

function mapSourceDenial(
  reason: SourceSendDeniedReason,
  result: Readonly<{
    nextAllowedAtMonotonicMs?: number;
    nextOpensAtEpochMs?: number;
  }>,
): CollectionCycleResult {
  const mappedReason: CollectionCycleDeferredReason = reason === 'invalid-monotonic-time' ||
      reason === 'invalid-wall-time'
    ? 'invalid-time'
    : reason;
  return Object.freeze({
    status: 'deferred',
    reason: mappedReason,
    ...(result.nextOpensAtEpochMs === undefined
      ? {}
      : { nextAtEpochMs: result.nextOpensAtEpochMs }),
    ...(result.nextAllowedAtMonotonicMs === undefined
      ? {}
      : { nextAtMonotonicMs: result.nextAllowedAtMonotonicMs }),
  });
}

function deferred(
  reason: CollectionCycleDeferredReason,
  nextAtEpochMs?: number,
): CollectionCycleResult {
  return Object.freeze({
    status: 'deferred',
    reason,
    ...(nextAtEpochMs === undefined ? {} : { nextAtEpochMs }),
  });
}
