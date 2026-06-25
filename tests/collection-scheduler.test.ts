import type { ArcGisClient, ArcGisCollectionResult } from '../src/harvesting/arcgis-client.ts';
import {
  type CollectionResiliencePolicy,
  createCollectionResiliencePolicy,
} from '../src/harvesting/collection-resilience.ts';
import { createCollectionScheduler } from '../src/harvesting/collection-scheduler.ts';
import { createDailyAttemptBudget } from '../src/harvesting/daily-attempt-budget.ts';
import {
  createMonotonicPermitGate,
  MIN_COLLECTION_INTERVAL_MS,
} from '../src/harvesting/monotonic-permit-gate.ts';
import {
  createOperatingWindowGate,
  type SourceAccessWindow,
} from '../src/harvesting/operating-window-gate.ts';
import {
  createSourceOperationLock,
  type SourceGateClock,
} from '../src/harvesting/source-send-gate.ts';

const WINDOW_START = 1_000_000;
const WINDOW_END = 3_000_000;
const DATE_KEY = '2026-06-24';

Deno.test('collection scheduler performs one gated attempt and never retries immediately', async () => {
  const clock = new FakeClock(WINDOW_START, 0);
  const context = createContext(clock, [failure('transport')]);

  const first = await context.scheduler.runCycle();
  const second = await context.scheduler.runCycle();

  assertEquals(first.status, 'attempted');
  assertEquals(second.status, 'deferred');
  if (second.status === 'deferred') {
    assertEquals(second.reason, 'backoff');
    assertEquals(second.nextAtMonotonicMs, MIN_COLLECTION_INTERVAL_MS);
  }
  assertEquals(context.sendCount(), 1);
});

Deno.test('collection scheduler safety deferrals produce zero source sends', async () => {
  const scenarios = [
    createContext(new FakeClock(WINDOW_START - 1, 0), [notModified()]),
    createContext(new FakeClock(WINDOW_START, 0), [notModified()], { pollEnabled: false }),
    createContext(new FakeClock(WINDOW_START, 0), [notModified()], { emergencyDisabled: true }),
  ];
  const expectedReasons = [
    'outside-operating-window',
    'poll-disabled',
    'emergency-disabled',
  ] as const;

  for (const [index, context] of scenarios.entries()) {
    const result = await context.scheduler.runCycle();
    assertEquals(result.status, 'deferred');
    if (result.status === 'deferred') {
      assertEquals(result.reason, expectedReasons[index]);
    }
    assertEquals(context.sendCount(), 0);
  }
});

Deno.test('collection scheduler denies an exhausted daily ceiling before source send', async () => {
  const clock = new FakeClock(WINDOW_START, 0);
  const context = createContext(clock, [notModified()]);
  const consumed = context.dailyBudget.consume(clock.nowEpochMs());
  assert(consumed.allowed, 'Expected test setup to consume one budget permit');
  while (context.dailyBudget.consume(clock.nowEpochMs()).allowed) {
    // Exhaust the finite window-derived ceiling without issuing source requests.
  }

  const result = await context.scheduler.runCycle();

  assertEquals(result.status, 'deferred');
  if (result.status === 'deferred') {
    assertEquals(result.reason, 'daily-ceiling');
  }
  assertEquals(context.sendCount(), 0);
});

Deno.test('collection scheduler observes an open circuit without source send', async () => {
  const clock = new FakeClock(WINDOW_START, MIN_COLLECTION_INTERVAL_MS);
  const resiliencePolicy = createResiliencePolicy(1);
  const acquired = resiliencePolicy.acquire(WINDOW_START, 0);
  assert(acquired.allowed, 'Expected setup acquisition');
  resiliencePolicy.record(acquired.mode, failure('transport'), WINDOW_START, 0);
  const context = createContext(clock, [notModified()], { resiliencePolicy });

  const result = await context.scheduler.runCycle();

  assertEquals(result.status, 'deferred');
  if (result.status === 'deferred') {
    assertEquals(result.reason, 'circuit-open');
  }
  assertEquals(context.sendCount(), 0);
});

Deno.test('daily attempt budget derives and retains ceilings by Eastern date', () => {
  const windows: readonly SourceAccessWindow[] = [
    { startsAtEpochMs: 0, endsAtEpochMs: 600_000 },
    { startsAtEpochMs: 900_000, endsAtEpochMs: 1_200_001 },
  ];
  const budget = createDailyAttemptBudget({
    sourceWindows: windows,
    minimumIntervalMs: MIN_COLLECTION_INTERVAL_MS,
    easternDateKey: () => DATE_KEY,
  });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const decision = budget.consume(1_000);
    assert(decision.allowed, `Expected attempt ${attempt} within ceiling`);
    assertEquals(decision.ceiling, 4);
    assertEquals(decision.attempts, attempt);
  }
  const denied = budget.consume(1_000);
  assert(!denied.allowed, 'Expected derived ceiling to deny the fifth attempt');
  assertEquals(denied.reason, 'ceiling-reached');
});

Deno.test('daily attempt budget exposes the first configured reset on a later Eastern date', () => {
  const budget = createDailyAttemptBudget({
    sourceWindows: [
      { startsAtEpochMs: 0, endsAtEpochMs: MIN_COLLECTION_INTERVAL_MS },
      { startsAtEpochMs: 400_000, endsAtEpochMs: 700_000 },
      { startsAtEpochMs: 800_000, endsAtEpochMs: 1_100_000 },
    ],
    minimumIntervalMs: MIN_COLLECTION_INTERVAL_MS,
    easternDateKey: (epochMs) => epochMs < 800_000 ? DATE_KEY : '2026-06-25',
  });
  const first = budget.consume(1);
  const second = budget.consume(400_001);
  assert(first.allowed && second.allowed, 'Expected both current-date attempts');

  const denied = budget.check(400_002);

  assert(!denied.allowed, 'Expected current Eastern date ceiling');
  assertEquals(denied.reason, 'ceiling-reached');
  assertEquals(denied.nextResetAtEpochMs, 800_000);
});

interface ContextOptions {
  readonly pollEnabled?: boolean;
  readonly emergencyDisabled?: boolean;
  readonly resiliencePolicy?: CollectionResiliencePolicy;
}

function createContext(
  clock: FakeClock,
  results: readonly ArcGisCollectionResult[],
  options: ContextOptions = {},
) {
  const sourceWindows = [{ startsAtEpochMs: WINDOW_START, endsAtEpochMs: WINDOW_END }] as const;
  const operatingWindowResult = createOperatingWindowGate(sourceWindows);
  if (!operatingWindowResult.ok) {
    throw new Error('Unexpected operating window configuration error');
  }
  const permitResult = createMonotonicPermitGate(MIN_COLLECTION_INTERVAL_MS);
  if (!permitResult.ok) {
    throw new Error('Unexpected permit configuration error');
  }

  let sends = 0;
  const client: ArcGisClient = Object.freeze({
    collect(): Promise<ArcGisCollectionResult> {
      const result = results[sends];
      if (result === undefined) {
        throw new Error('Unexpected extra collection attempt');
      }
      sends += 1;
      return Promise.resolve(result);
    },
  });
  const dailyBudget = createDailyAttemptBudget({
    sourceWindows,
    minimumIntervalMs: MIN_COLLECTION_INTERVAL_MS,
    easternDateKey: () => DATE_KEY,
  });
  const resiliencePolicy = options.resiliencePolicy ?? createResiliencePolicy();
  const sourceSendGate = Object.freeze({
    clock,
    operatingWindowGate: operatingWindowResult.gate,
    permitGate: permitResult.gate,
    operationLock: createSourceOperationLock(),
  });

  return Object.freeze({
    scheduler: createCollectionScheduler({
      pollEnabled: options.pollEnabled ?? true,
      emergencyDisabled: () => options.emergencyDisabled ?? false,
      clock,
      operatingWindowGate: operatingWindowResult.gate,
      sourceSendGate,
      dailyAttemptBudget: dailyBudget,
      resiliencePolicy,
      client,
    }),
    dailyBudget,
    sendCount: () => sends,
  });
}

function createResiliencePolicy(threshold = 5): CollectionResiliencePolicy {
  return createCollectionResiliencePolicy({
    pollIntervalMs: MIN_COLLECTION_INTERVAL_MS,
    maxBackoffMs: 1_800_000,
    circuitFailureThreshold: threshold,
    circuitInitialBreakMs: 600_000,
    random: () => 0,
  });
}

function failure(failureClass: 'transport'): ArcGisCollectionResult {
  return Object.freeze({ ok: false, failureClass });
}

function notModified(): ArcGisCollectionResult {
  return Object.freeze({ ok: true, result: 'not-modified' });
}

class FakeClock implements SourceGateClock {
  constructor(public wallEpochMs: number, public monotonicMs: number) {}

  nowEpochMs(): number {
    return this.wallEpochMs;
  }

  nowMonotonicMs(): number {
    return this.monotonicMs;
  }
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
