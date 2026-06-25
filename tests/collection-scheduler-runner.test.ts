import {
  type CollectionSchedulerTimer,
  createCollectionSchedulerRunner,
  MAX_STARTUP_JITTER_MS,
  MAX_TIMER_DELAY_MS,
} from '../src/harvesting/collection-scheduler-runner.ts';
import type {
  CollectionCycleResult,
  CollectionScheduler,
} from '../src/harvesting/collection-scheduler.ts';
import { createOperatingWindowGate } from '../src/harvesting/operating-window-gate.ts';
import type { SourceGateClock } from '../src/harvesting/source-send-gate.ts';

const POLL_INTERVAL_MS = 300_000;

Deno.test('scheduler runner starts once with bounded injected jitter', async () => {
  const clock = new FakeClock(100_000, 1_000);
  const timer = new FakeTimer();
  const scheduler = new SequenceScheduler([deferredResult('operator-review')]);
  const runner = createRunner(clock, timer, scheduler, [[0, 1_000_000]], 0.5);

  runner.start();
  runner.start();

  assertEquals(timer.size, 1);
  assertEquals(timer.nextDelayMs, MAX_STARTUP_JITTER_MS / 2);

  await timer.advanceAndFire(clock);
  assertEquals(scheduler.runCount, 1);
  assertEquals(timer.size, 0);

  runner.stop();
  runner.stop();
});

Deno.test('scheduler runner defers closed startup until the exact next opening', () => {
  const clock = new FakeClock(100_000, 500);
  const timer = new FakeTimer();
  const runner = createRunner(
    clock,
    timer,
    new SequenceScheduler([]),
    [[200_000, 400_000]],
    1,
  );

  runner.start();

  assertEquals(timer.size, 1);
  assertEquals(timer.nextDelayMs, 100_000);
});

Deno.test('scheduler runner uses the latest deadline and advances it to an active window', async () => {
  const clock = new FakeClock(60_000, 0);
  const timer = new FakeTimer();
  const scheduler = new SequenceScheduler([
    attemptedResult({
      nextAtMonotonicMs: 50_000,
      retryAtEpochMs: 130_000,
      circuit: Object.freeze({
        state: 'open',
        breakDurationMs: 80_000,
        probeAtMonotonicMs: 80_000,
      }),
    }),
    deferredResult('operator-review'),
  ]);
  const runner = createRunner(
    clock,
    timer,
    scheduler,
    [[0, 120_000], [300_000, 500_000]],
  );

  runner.start();
  await timer.advanceAndFire(clock);

  assertEquals(scheduler.runCount, 1);
  assertEquals(timer.size, 1);
  assertEquals(timer.nextDelayMs, 240_000);

  await timer.advanceAndFire(clock);
  assertEquals(scheduler.runCount, 2);
  assertEquals(timer.size, 0);
});

Deno.test('scheduler runner performs no catch-up burst after a delayed callback', async () => {
  const clock = new FakeClock(1_000_000, 0);
  const timer = new FakeTimer();
  const scheduler = new SequenceScheduler([
    attemptedResult({
      nextAtMonotonicMs: POLL_INTERVAL_MS,
      circuit: closedCircuit(),
    }),
    attemptedResult({
      nextAtMonotonicMs: 1_200_000,
      circuit: closedCircuit(),
    }),
  ]);
  const runner = createRunner(clock, timer, scheduler, [[0, 3_000_000]]);

  runner.start();
  await timer.advanceAndFire(clock);
  assertEquals(timer.nextDelayMs, POLL_INTERVAL_MS);

  clock.advance(900_000);
  await timer.fireNext();

  assertEquals(scheduler.runCount, 2);
  assertEquals(timer.size, 1);
  assertEquals(timer.nextDelayMs, POLL_INTERVAL_MS);
});

Deno.test('scheduler runner chunks long waits and rechecks before running a cycle', async () => {
  const openingEpochMs = MAX_TIMER_DELAY_MS + 100;
  const clock = new FakeClock(0, 0);
  const timer = new FakeTimer();
  const scheduler = new SequenceScheduler([deferredResult('operator-review')]);
  const runner = createRunner(
    clock,
    timer,
    scheduler,
    [[openingEpochMs, openingEpochMs + 1_000_000]],
  );

  runner.start();
  assertEquals(timer.nextDelayMs, MAX_TIMER_DELAY_MS);

  await timer.advanceAndFire(clock);
  assertEquals(scheduler.runCount, 0);
  assertEquals(timer.nextDelayMs, 100);

  await timer.advanceAndFire(clock);
  assertEquals(scheduler.runCount, 1);
  assertEquals(timer.size, 0);
});

Deno.test('scheduler runner resumes a daily ceiling only at its explicit reset deadline', async () => {
  const clock = new FakeClock(10, 10);
  const timer = new FakeTimer();
  const scheduler = new SequenceScheduler([
    deferredResult('daily-ceiling', 200),
    deferredResult('operator-review'),
  ]);
  const runner = createRunner(clock, timer, scheduler, [[0, 100], [200, 300]]);

  runner.start();
  await timer.advanceAndFire(clock);

  assertEquals(timer.nextDelayMs, 190);
  await timer.advanceAndFire(clock);
  assertEquals(scheduler.runCount, 2);
  assertEquals(timer.size, 0);
});

Deno.test('scheduler runner remains stopped when a daily ceiling has no reset deadline', async () => {
  const clock = new FakeClock(10, 10);
  const timer = new FakeTimer();
  const scheduler = new SequenceScheduler([deferredResult('daily-ceiling')]);
  const runner = createRunner(clock, timer, scheduler, [[0, 100], [200, 300]]);

  runner.start();
  await timer.advanceAndFire(clock);

  assertEquals(scheduler.runCount, 1);
  assertEquals(timer.size, 0);
});

Deno.test('scheduler runner stop prevents rescheduling after an in-flight cycle', async () => {
  const clock = new FakeClock(1_000, 1_000);
  const timer = new FakeTimer();
  const pending = deferred<CollectionCycleResult>();
  const scheduler: CollectionScheduler = Object.freeze({
    runCycle: () => pending.promise,
  });
  const runner = createRunner(clock, timer, scheduler, [[0, 1_000_000]]);

  runner.start();
  const firing = timer.fireNext();
  await Promise.resolve();
  runner.stop();
  pending.resolve(deferredResult('operation-in-progress'));
  await firing;

  assertEquals(timer.size, 0);
});

function createRunner(
  clock: FakeClock,
  timer: FakeTimer,
  scheduler: CollectionScheduler,
  windows: readonly (readonly [number, number])[],
  random = 0,
) {
  const operatingWindowResult = createOperatingWindowGate(
    windows.map(([startsAtEpochMs, endsAtEpochMs]) => ({
      startsAtEpochMs,
      endsAtEpochMs,
    })),
  );
  if (!operatingWindowResult.ok) {
    throw new Error(`Unexpected operating window error: ${operatingWindowResult.error.code}`);
  }

  return createCollectionSchedulerRunner({
    scheduler,
    operatingWindowGate: operatingWindowResult.gate,
    clock,
    timer,
    pollIntervalMs: POLL_INTERVAL_MS,
    random: () => random,
  });
}

class SequenceScheduler implements CollectionScheduler {
  runCount = 0;

  constructor(private readonly results: readonly CollectionCycleResult[]) {}

  runCycle(): Promise<CollectionCycleResult> {
    const result = this.results[this.runCount];
    if (result === undefined) {
      throw new Error('Unexpected scheduler cycle');
    }
    this.runCount += 1;
    return Promise.resolve(result);
  }
}

class FakeClock implements SourceGateClock {
  constructor(public epochMs: number, public monotonicMs: number) {}

  nowEpochMs(): number {
    return this.epochMs;
  }

  nowMonotonicMs(): number {
    return this.monotonicMs;
  }

  advance(delayMs: number): void {
    this.epochMs += delayMs;
    this.monotonicMs += delayMs;
  }
}

class FakeTimer implements CollectionSchedulerTimer {
  #nextHandle = 1;
  #entries = new Map<
    number,
    Readonly<{
      callback: () => void | Promise<void>;
      delayMs: number;
    }>
  >();

  get size(): number {
    return this.#entries.size;
  }

  get nextDelayMs(): number | undefined {
    return this.nextEntry()?.delayMs;
  }

  set(callback: () => void | Promise<void>, delayMs: number): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#entries.set(handle, Object.freeze({ callback, delayMs }));
    return handle;
  }

  clear(handle: number): void {
    this.#entries.delete(handle);
  }

  async advanceAndFire(clock: FakeClock): Promise<void> {
    const entry = this.nextEntry();
    if (entry === undefined) {
      throw new Error('Expected a scheduled timer');
    }
    clock.advance(entry.delayMs);
    await this.fireNext();
  }

  async fireNext(): Promise<void> {
    const first = this.#entries.entries().next().value;
    if (first === undefined) {
      throw new Error('Expected a scheduled timer');
    }
    const [handle, entry] = first;
    this.#entries.delete(handle);
    await entry.callback();
  }

  private nextEntry() {
    return this.#entries.values().next().value;
  }
}

function attemptedResult(
  schedule: Extract<CollectionCycleResult, { status: 'attempted' }>['schedule'],
): CollectionCycleResult {
  return Object.freeze({
    status: 'attempted',
    result: Object.freeze({ ok: true, result: 'not-modified' }),
    schedule,
  });
}

function deferredResult(
  reason: Extract<CollectionCycleResult, { status: 'deferred' }>['reason'],
  nextAtEpochMs?: number,
): CollectionCycleResult {
  return Object.freeze({
    status: 'deferred',
    reason,
    ...(nextAtEpochMs === undefined ? {} : { nextAtEpochMs }),
  });
}

function closedCircuit() {
  return Object.freeze({ state: 'closed' as const, consecutiveFailures: 0 });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error('Failed to create deferred promise');
  }
  return Object.freeze({ promise, resolve: resolvePromise });
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
