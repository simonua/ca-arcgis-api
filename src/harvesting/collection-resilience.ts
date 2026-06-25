import type { ArcGisCollectionResult } from './arcgis-client.ts';
import type { ArcGisFailureClass } from '../telemetry/arcgis-events.ts';

const BACKOFF_JITTER_RATIO = 0.1;
const MAX_CIRCUIT_BREAK_MULTIPLIER = 4;

export type CollectionCircuitState =
  | Readonly<{
    state: 'closed';
    consecutiveFailures: number;
    failureClass?: ArcGisFailureClass;
  }>
  | Readonly<{
    state: 'open';
    breakDurationMs: number;
    probeAtMonotonicMs: number;
  }>
  | Readonly<{ state: 'half-open'; breakDurationMs: number }>
  | Readonly<{
    state: 'operator-review';
    reason: ArcGisFailureClass | 'retry-after';
  }>;

export type CollectionResilienceDecision =
  | Readonly<{ allowed: true; mode: CollectionAttemptMode }>
  | Readonly<{
    allowed: false;
    reason:
      | 'backoff'
      | 'circuit-half-open'
      | 'circuit-open'
      | 'invalid-time'
      | 'operator-review'
      | 'retry-after';
    nextAtEpochMs?: number;
    nextAtMonotonicMs?: number;
  }>;

export interface CollectionResilienceSchedule {
  readonly circuit: CollectionCircuitState;
  readonly nextAtMonotonicMs: number;
  readonly retryAtEpochMs?: number;
}

export interface CollectionResiliencePolicy {
  acquire(nowEpochMs: number, nowMonotonicMs: number): CollectionResilienceDecision;
  cancel(mode: CollectionAttemptMode, nowMonotonicMs: number): void;
  record(
    mode: CollectionAttemptMode,
    result: ArcGisCollectionResult,
    completedAtEpochMs: number,
    completedAtMonotonicMs: number,
  ): CollectionResilienceSchedule;
  snapshot(): CollectionCircuitState;
}

export type CollectionAttemptMode = 'normal' | 'half-open';

export interface CollectionResilienceOptions {
  readonly pollIntervalMs: number;
  readonly maxBackoffMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitInitialBreakMs: number;
  readonly random: () => number;
}

/** Owns completion-based backoff and the collection circuit without issuing retries. */
export function createCollectionResiliencePolicy(
  options: CollectionResilienceOptions,
): CollectionResiliencePolicy {
  let circuit: CollectionCircuitState = closedCircuit();
  let backoffFailures = 0;
  let nextAtMonotonicMs = 0;
  let retryAtEpochMs: number | undefined;

  return Object.freeze({
    acquire(nowEpochMs: number, nowMonotonicMs: number): CollectionResilienceDecision {
      if (!isTime(nowEpochMs) || !isTime(nowMonotonicMs)) {
        return Object.freeze({ allowed: false, reason: 'invalid-time' });
      }
      if (nowMonotonicMs < nextAtMonotonicMs) {
        return Object.freeze({
          allowed: false,
          reason: 'backoff',
          nextAtMonotonicMs,
        });
      }
      if (retryAtEpochMs !== undefined && nowEpochMs < retryAtEpochMs) {
        return Object.freeze({
          allowed: false,
          reason: 'retry-after',
          nextAtEpochMs: retryAtEpochMs,
        });
      }

      switch (circuit.state) {
        case 'operator-review':
          return Object.freeze({ allowed: false, reason: 'operator-review' });
        case 'half-open':
          return Object.freeze({ allowed: false, reason: 'circuit-half-open' });
        case 'open':
          if (nowMonotonicMs < circuit.probeAtMonotonicMs) {
            return Object.freeze({
              allowed: false,
              reason: 'circuit-open',
              nextAtMonotonicMs: circuit.probeAtMonotonicMs,
            });
          }
          circuit = Object.freeze({
            state: 'half-open',
            breakDurationMs: circuit.breakDurationMs,
          });
          return Object.freeze({ allowed: true, mode: 'half-open' });
        case 'closed':
          return Object.freeze({ allowed: true, mode: 'normal' });
      }
    },

    cancel(mode: CollectionAttemptMode, nowMonotonicMs: number): void {
      if (mode === 'half-open' && circuit.state === 'half-open') {
        circuit = Object.freeze({
          state: 'open',
          breakDurationMs: circuit.breakDurationMs,
          probeAtMonotonicMs: isTime(nowMonotonicMs) ? nowMonotonicMs : nextAtMonotonicMs,
        });
      }
    },

    record(
      mode: CollectionAttemptMode,
      result: ArcGisCollectionResult,
      completedAtEpochMs: number,
      completedAtMonotonicMs: number,
    ): CollectionResilienceSchedule {
      if (!isTime(completedAtEpochMs) || !isTime(completedAtMonotonicMs)) {
        circuit = Object.freeze({ state: 'operator-review', reason: 'transport' });
        nextAtMonotonicMs = Number.MAX_SAFE_INTEGER;
        retryAtEpochMs = undefined;
        return schedule();
      }

      if (result.ok) {
        circuit = closedCircuit();
        backoffFailures = 0;
        retryAtEpochMs = undefined;
        nextAtMonotonicMs = completedAtMonotonicMs + options.pollIntervalMs;
        return schedule();
      }

      backoffFailures += 1;
      const exponentialDelay = Math.min(
        options.maxBackoffMs,
        options.pollIntervalMs * (2 ** Math.min(backoffFailures - 1, 30)),
      );
      const randomValue = options.random();
      const boundedRandom = Number.isFinite(randomValue) && randomValue >= 0 && randomValue <= 1
        ? randomValue
        : 0;
      const delayMs = Math.min(
        options.maxBackoffMs,
        exponentialDelay + Math.floor(exponentialDelay * BACKOFF_JITTER_RATIO * boundedRandom),
      );
      nextAtMonotonicMs = completedAtMonotonicMs + delayMs;
      retryAtEpochMs = result.retryAfter?.status === 'accepted'
        ? result.retryAfter.retryAtEpochMs
        : undefined;

      if (result.retryAfter?.status === 'operator-review') {
        circuit = Object.freeze({ state: 'operator-review', reason: 'retry-after' });
        return schedule();
      }
      if (requiresImmediateReview(result.failureClass)) {
        circuit = Object.freeze({ state: 'operator-review', reason: result.failureClass });
        return schedule();
      }
      if (mode === 'half-open') {
        const priorBreak = circuit.state === 'half-open'
          ? circuit.breakDurationMs
          : options.circuitInitialBreakMs;
        const breakDurationMs = Math.min(
          priorBreak * 2,
          options.circuitInitialBreakMs * MAX_CIRCUIT_BREAK_MULTIPLIER,
        );
        circuit = Object.freeze({
          state: 'open',
          breakDurationMs,
          probeAtMonotonicMs: completedAtMonotonicMs + breakDurationMs,
        });
        return schedule();
      }

      const consecutiveFailures = circuit.state === 'closed' &&
          circuit.failureClass === result.failureClass
        ? circuit.consecutiveFailures + 1
        : 1;
      if (consecutiveFailures >= options.circuitFailureThreshold) {
        circuit = Object.freeze({
          state: 'open',
          breakDurationMs: options.circuitInitialBreakMs,
          probeAtMonotonicMs: completedAtMonotonicMs + options.circuitInitialBreakMs,
        });
      } else {
        circuit = closedCircuit(consecutiveFailures, result.failureClass);
      }
      return schedule();
    },

    snapshot(): CollectionCircuitState {
      return circuit;
    },
  });

  function schedule(): CollectionResilienceSchedule {
    return Object.freeze({
      circuit,
      nextAtMonotonicMs,
      ...(retryAtEpochMs === undefined ? {} : { retryAtEpochMs }),
    });
  }
}

function closedCircuit(
  consecutiveFailures = 0,
  failureClass?: ArcGisFailureClass,
): CollectionCircuitState {
  return Object.freeze({
    state: 'closed',
    consecutiveFailures,
    ...(failureClass === undefined ? {} : { failureClass }),
  });
}

function requiresImmediateReview(failureClass: ArcGisFailureClass): boolean {
  return failureClass === 'authorization' || failureClass === 'http-client-error' ||
    failureClass === 'redirect' || failureClass === 'response-oversized';
}

function isTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
