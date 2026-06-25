import type {
  CollectionCycleDeferredReason,
  CollectionCycleResult,
  CollectionScheduler,
} from './collection-scheduler.ts';
import type { OperatingWindowGate } from './operating-window-gate.ts';
import type { SourceGateClock } from './source-send-gate.ts';

export const MAX_STARTUP_JITTER_MS = 30_000 as const;
export const MAX_TIMER_DELAY_MS = 2_147_483_647 as const;

export interface CollectionSchedulerTimer {
  set(callback: () => void | Promise<void>, delayMs: number): number;
  clear(handle: number): void;
}

export interface CollectionSchedulerRunner {
  start(): void;
  stop(): void;
}

export interface CollectionSchedulerRunnerDependencies {
  readonly scheduler: CollectionScheduler;
  readonly operatingWindowGate: OperatingWindowGate;
  readonly clock: SourceGateClock;
  readonly timer: CollectionSchedulerTimer;
  readonly pollIntervalMs: number;
  readonly random: () => number;
}

interface RunnerDeadline {
  readonly atEpochMs?: number;
  readonly atMonotonicMs?: number;
}

/** Drives one injected collection scheduler with at most one timer and no catch-up execution. */
export function createCollectionSchedulerRunner(
  dependencies: CollectionSchedulerRunnerDependencies,
): CollectionSchedulerRunner {
  let started = false;
  let stopped = false;
  let running = false;
  let timerHandle: number | undefined;
  let deadline: RunnerDeadline | undefined;

  return Object.freeze({
    start(): void {
      if (started || stopped) {
        return;
      }
      started = true;

      const nowEpochMs = dependencies.clock.nowEpochMs();
      const nowMonotonicMs = dependencies.clock.nowMonotonicMs();
      if (!isTime(nowEpochMs) || !isTime(nowMonotonicMs)) {
        return;
      }

      const jitterMs = boundedStartupJitter(dependencies.random());
      const window = dependencies.operatingWindowGate.evaluate(nowEpochMs);
      if (window.allowed) {
        schedule({ atMonotonicMs: nowMonotonicMs + jitterMs });
        return;
      }
      if (window.reason === 'closed' && window.nextOpensAtEpochMs !== undefined) {
        schedule({ atEpochMs: window.nextOpensAtEpochMs });
      }
    },

    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      deadline = undefined;
      clearTimer();
    },
  });

  function schedule(candidate: RunnerDeadline): void {
    if (stopped || !validDeadline(candidate)) {
      return;
    }
    const adjusted = adjustToOperatingWindow(candidate);
    if (adjusted === undefined) {
      deadline = undefined;
      clearTimer();
      return;
    }

    deadline = adjusted;
    clearTimer();
    armTimer();
  }

  function armTimer(): void {
    if (stopped || running || deadline === undefined || timerHandle !== undefined) {
      return;
    }
    const delayMs = remainingDelay(deadline);
    if (delayMs === undefined) {
      deadline = undefined;
      return;
    }
    timerHandle = dependencies.timer.set(onWake, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  }

  async function onWake(): Promise<void> {
    timerHandle = undefined;
    if (stopped || running || deadline === undefined) {
      return;
    }

    const delayMs = remainingDelay(deadline);
    if (delayMs === undefined) {
      deadline = undefined;
      return;
    }
    if (delayMs > 0) {
      armTimer();
      return;
    }

    deadline = undefined;
    running = true;
    try {
      const result = await dependencies.scheduler.runCycle();
      if (!stopped) {
        scheduleFromResult(result);
      }
    } catch {
      if (!stopped) {
        scheduleAfterInterval();
      }
    } finally {
      running = false;
      if (!stopped && deadline !== undefined) {
        armTimer();
      }
    }
  }

  function scheduleFromResult(result: CollectionCycleResult): void {
    if (result.status === 'attempted') {
      if (result.schedule.circuit.state === 'operator-review') {
        return;
      }
      const circuitDeadline = result.schedule.circuit.state === 'open'
        ? result.schedule.circuit.probeAtMonotonicMs
        : undefined;
      schedule({
        atMonotonicMs: maximumDefined(
          result.schedule.nextAtMonotonicMs,
          circuitDeadline,
        ),
        ...(result.schedule.retryAtEpochMs === undefined
          ? {}
          : { atEpochMs: result.schedule.retryAtEpochMs }),
      });
      return;
    }

    if (result.nextAtEpochMs !== undefined || result.nextAtMonotonicMs !== undefined) {
      schedule({
        ...(result.nextAtEpochMs === undefined ? {} : { atEpochMs: result.nextAtEpochMs }),
        ...(result.nextAtMonotonicMs === undefined
          ? {}
          : { atMonotonicMs: result.nextAtMonotonicMs }),
      });
      return;
    }

    if (isTransientWithoutDeadline(result.reason)) {
      scheduleAfterInterval();
    }
  }

  function scheduleAfterInterval(): void {
    const nowMonotonicMs = dependencies.clock.nowMonotonicMs();
    if (isTime(nowMonotonicMs)) {
      schedule({ atMonotonicMs: nowMonotonicMs + dependencies.pollIntervalMs });
    }
  }

  function adjustToOperatingWindow(candidate: RunnerDeadline): RunnerDeadline | undefined {
    const nowEpochMs = dependencies.clock.nowEpochMs();
    const nowMonotonicMs = dependencies.clock.nowMonotonicMs();
    if (!isTime(nowEpochMs) || !isTime(nowMonotonicMs)) {
      return undefined;
    }
    const delayMs = deadlineDelay(candidate, nowEpochMs, nowMonotonicMs);
    if (delayMs === undefined) {
      return undefined;
    }
    const projectedEpochMs = nowEpochMs + delayMs;
    if (!isTime(projectedEpochMs)) {
      return undefined;
    }
    const projectedWindow = dependencies.operatingWindowGate.evaluate(projectedEpochMs);
    if (projectedWindow.allowed) {
      return Object.freeze(candidate);
    }
    if (projectedWindow.reason === 'closed' && projectedWindow.nextOpensAtEpochMs !== undefined) {
      return Object.freeze({
        ...candidate,
        atEpochMs: maximumDefined(candidate.atEpochMs, projectedWindow.nextOpensAtEpochMs),
      });
    }
    return undefined;
  }

  function remainingDelay(target: RunnerDeadline): number | undefined {
    const nowEpochMs = dependencies.clock.nowEpochMs();
    const nowMonotonicMs = dependencies.clock.nowMonotonicMs();
    if (!isTime(nowEpochMs) || !isTime(nowMonotonicMs)) {
      return undefined;
    }
    return deadlineDelay(target, nowEpochMs, nowMonotonicMs);
  }

  function clearTimer(): void {
    if (timerHandle !== undefined) {
      dependencies.timer.clear(timerHandle);
      timerHandle = undefined;
    }
  }
}

function deadlineDelay(
  deadline: RunnerDeadline,
  nowEpochMs: number,
  nowMonotonicMs: number,
): number | undefined {
  const epochDelay = deadline.atEpochMs === undefined ? 0 : deadline.atEpochMs - nowEpochMs;
  const monotonicDelay = deadline.atMonotonicMs === undefined
    ? 0
    : deadline.atMonotonicMs - nowMonotonicMs;
  const delayMs = Math.max(0, epochDelay, monotonicDelay);
  return Number.isSafeInteger(delayMs) ? delayMs : undefined;
}

function boundedStartupJitter(randomValue: number): number {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    return 0;
  }
  return Math.floor(MAX_STARTUP_JITTER_MS * randomValue);
}

function isTransientWithoutDeadline(reason: CollectionCycleDeferredReason): boolean {
  return reason === 'circuit-half-open' || reason === 'operation-in-progress';
}

function maximumDefined(first: number | undefined, second: number | undefined): number {
  return Math.max(first ?? 0, second ?? 0);
}

function validDeadline(deadline: RunnerDeadline): boolean {
  return (deadline.atEpochMs !== undefined && isTime(deadline.atEpochMs)) ||
    (deadline.atMonotonicMs !== undefined && isTime(deadline.atMonotonicMs));
}

function isTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
