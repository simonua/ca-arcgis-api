import type { ArcGisCollectionResult } from '../src/harvesting/arcgis-client.ts';
import {
  type CollectionResiliencePolicy,
  createCollectionResiliencePolicy,
} from '../src/harvesting/collection-resilience.ts';
import type { ArcGisFailureClass } from '../src/telemetry/arcgis-events.ts';

const INTERVAL_MS = 300_000;
const INITIAL_BREAK_MS = 600_000;

Deno.test('collection resilience applies completion-based exponential backoff and resets on success', () => {
  const policy = createPolicy(3, 0.5);
  const first = acquire(policy, 1_000, 1_000);
  const firstSchedule = policy.record(first.mode, failure('transport'), 2_000, 2_000);

  assertEquals(firstSchedule.nextAtMonotonicMs, 317_000);
  assertDeferred(policy.acquire(100_000, 317_000 - 1), 'backoff');

  const second = acquire(policy, 400_000, 317_000);
  const secondSchedule = policy.record(second.mode, failure('transport'), 401_000, 318_000);
  assertEquals(secondSchedule.nextAtMonotonicMs, 948_000);

  const third = acquire(policy, 1_100_000, 948_000);
  const successSchedule = policy.record(third.mode, notModified(), 1_101_000, 949_000);
  assertEquals(successSchedule.nextAtMonotonicMs, 1_249_000);
  assertEquals(successSchedule.circuit.state, 'closed');
  if (successSchedule.circuit.state === 'closed') {
    assertEquals(successSchedule.circuit.consecutiveFailures, 0);
  }
});

Deno.test('collection resilience honors a longer valid Retry-After deadline', () => {
  const policy = createPolicy();
  const acquired = acquire(policy, 1_000, 1_000);
  const schedule = policy.record(
    acquired.mode,
    Object.freeze({
      ok: false,
      failureClass: 'rate-limited',
      retryAfter: Object.freeze({ status: 'accepted', retryAtEpochMs: 2_000_000 }),
    }),
    2_000,
    2_000,
  );

  assertEquals(schedule.nextAtMonotonicMs, 302_000);
  assertEquals(schedule.retryAtEpochMs, 2_000_000);
  assertDeferred(policy.acquire(1_999_999, 400_000), 'retry-after');
  assertEquals(acquire(policy, 2_000_000, 400_000).mode, 'normal');
});

Deno.test('collection circuit counts consecutive failures by fixed class', () => {
  const policy = createPolicy(2);
  const first = recordFailure(policy, 'transport', 0);
  const second = recordFailure(policy, 'timeout', first.nextAtMonotonicMs);

  const afterClassChange = policy.snapshot();
  assertEquals(afterClassChange.state, 'closed');
  if (afterClassChange.state === 'closed') {
    assertEquals(afterClassChange.consecutiveFailures, 1);
    assertEquals(afterClassChange.failureClass, 'timeout');
  }

  recordFailure(policy, 'timeout', second.nextAtMonotonicMs);
  assertEquals(policy.snapshot().state, 'open');
});

Deno.test('collection circuit permits one half-open probe and lengthens cooldown after failure', () => {
  const policy = createPolicy(2);
  const first = recordFailure(policy, 'transport', 0);
  const opened = recordFailure(policy, 'transport', first.nextAtMonotonicMs);
  assertEquals(opened.circuit.state, 'open');
  if (opened.circuit.state !== 'open') {
    throw new Error('Expected an open circuit');
  }

  const early = policy.acquire(2_000_000, opened.circuit.probeAtMonotonicMs - 1);
  assert(!early.allowed, 'Expected open circuit deadlines to defer');
  const probe = acquire(policy, 2_000_000, opened.circuit.probeAtMonotonicMs);
  assertEquals(probe.mode, 'half-open');
  assertDeferred(
    policy.acquire(2_000_000, opened.circuit.probeAtMonotonicMs),
    'circuit-half-open',
  );

  const reopened = policy.record(
    probe.mode,
    failure('http-server-error'),
    2_000_001,
    opened.circuit.probeAtMonotonicMs + 1,
  );
  assertEquals(reopened.circuit.state, 'open');
  if (reopened.circuit.state === 'open') {
    assertEquals(reopened.circuit.breakDurationMs, INITIAL_BREAK_MS * 2);
  }
});

Deno.test('unsafe responses and implausible Retry-After values require operator review', () => {
  for (
    const result of [
      failure('redirect'),
      Object.freeze({
        ok: false,
        failureClass: 'rate-limited',
        retryAfter: Object.freeze({ status: 'operator-review' }),
      }) satisfies ArcGisCollectionResult,
    ]
  ) {
    const policy = createPolicy();
    const acquired = acquire(policy, 0, 0);
    const schedule = policy.record(acquired.mode, result, 1, 1);

    assertEquals(schedule.circuit.state, 'operator-review');
    assertDeferred(policy.acquire(2_000_000, 2_000_000), 'operator-review');
  }
});

function createPolicy(threshold = 5, random = 0): CollectionResiliencePolicy {
  return createCollectionResiliencePolicy({
    pollIntervalMs: INTERVAL_MS,
    maxBackoffMs: 1_800_000,
    circuitFailureThreshold: threshold,
    circuitInitialBreakMs: INITIAL_BREAK_MS,
    random: () => random,
  });
}

function recordFailure(
  policy: CollectionResiliencePolicy,
  failureClass: ArcGisFailureClass,
  completedAtMonotonicMs: number,
) {
  const acquired = acquire(
    policy,
    completedAtMonotonicMs + 10_000_000,
    completedAtMonotonicMs,
  );
  return policy.record(
    acquired.mode,
    failure(failureClass),
    completedAtMonotonicMs,
    completedAtMonotonicMs,
  );
}

function acquire(policy: CollectionResiliencePolicy, epochMs: number, monotonicMs: number) {
  const decision = policy.acquire(epochMs, monotonicMs);
  if (!decision.allowed) {
    throw new Error(`Expected acquisition, received ${decision.reason}`);
  }
  return decision;
}

function failure(failureClass: ArcGisFailureClass): ArcGisCollectionResult {
  return Object.freeze({ ok: false, failureClass });
}

function notModified(): ArcGisCollectionResult {
  return Object.freeze({ ok: true, result: 'not-modified' });
}

function assertDeferred(
  decision: ReturnType<CollectionResiliencePolicy['acquire']>,
  reason: string,
): void {
  assert(!decision.allowed, 'Expected resilience policy to defer');
  assertEquals(decision.reason, reason);
}

function assert(condition: boolean, message = 'Assertion failed'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
