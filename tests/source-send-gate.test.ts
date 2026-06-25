import {
  createMonotonicPermitGate,
  MIN_COLLECTION_INTERVAL_MS,
} from '../src/harvesting/monotonic-permit-gate.ts';
import { createOperatingWindowGate } from '../src/harvesting/operating-window-gate.ts';
import {
  createSourceOperationLock,
  executeGatedSourceSend,
  type SourceGateClock,
  type SourceSendGateDependencies,
} from '../src/harvesting/source-send-gate.ts';

const WINDOW_START = 1_000_000;
const WINDOW_END = 2_000_000;

Deno.test('denies closed-window operations without invoking the sender', async () => {
  const clock = new FakeClock(WINDOW_START - 1, 0);
  const dependencies = createDependencies(clock);
  let sendCount = 0;

  const result = await executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return Promise.resolve('unexpected');
  });

  assertEquals(result.status, 'denied');
  if (result.status === 'denied') {
    assertEquals(result.reason, 'outside-operating-window');
    assertEquals(result.nextOpensAtEpochMs, WINDOW_START);
  }
  assertEquals(sendCount, 0);
});

Deno.test('rechecks the operating window immediately before send', async () => {
  const clock = new SequencedClock([WINDOW_START, WINDOW_END], [0]);
  const dependencies = createDependencies(clock);
  let sendCount = 0;

  const result = await executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return Promise.resolve('unexpected');
  });

  assertEquals(result.status, 'denied');
  if (result.status === 'denied') {
    assertEquals(result.reason, 'outside-operating-window');
  }
  assertEquals(sendCount, 0);
});

Deno.test('denies invalid wall and monotonic clocks without invoking the sender', async () => {
  const clocks: readonly SourceGateClock[] = [
    new FakeClock(Number.NaN, 0),
    new SequencedClock([WINDOW_START, Number.NaN], [0]),
    new FakeClock(WINDOW_START, Number.NaN),
  ];
  const expectedReasons = [
    'invalid-wall-time',
    'invalid-wall-time',
    'invalid-monotonic-time',
  ] as const;
  let sendCount = 0;

  for (const [index, clock] of clocks.entries()) {
    const result = await executeGatedSourceSend(createDependencies(clock), () => {
      sendCount += 1;
      return Promise.resolve('unexpected');
    });

    assertEquals(result.status, 'denied');
    if (result.status === 'denied') {
      assertEquals(result.reason, expectedReasons[index]);
    }
  }

  assertEquals(sendCount, 0);
});

Deno.test('denies a second operation until its monotonic permit is restored', async () => {
  const clock = new FakeClock(WINDOW_START, 100);
  const dependencies = createDependencies(clock);
  let sendCount = 0;

  const first = await executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return Promise.resolve('accepted');
  });
  const second = await executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return Promise.resolve('unexpected');
  });

  assertEquals(first.status, 'sent');
  assertEquals(second.status, 'denied');
  if (second.status === 'denied') {
    assertEquals(second.reason, 'permit-unavailable');
    assertEquals(second.nextAllowedAtMonotonicMs, 300_100);
  }
  assertEquals(sendCount, 1);
});

Deno.test('denies concurrent source operations without queueing another send', async () => {
  const firstClock = new FakeClock(WINDOW_START, 0);
  const dependencies = createDependencies(firstClock);
  const sender = deferred<string>();
  let sendCount = 0;

  const firstResult = executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return sender.promise;
  });
  await Promise.resolve();

  const secondResult = await executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return Promise.resolve('unexpected');
  });

  assertEquals(secondResult.status, 'denied');
  if (secondResult.status === 'denied') {
    assertEquals(secondResult.reason, 'operation-in-progress');
  }
  assertEquals(sendCount, 1);

  sender.resolve('accepted');
  assertEquals((await firstResult).status, 'sent');
});

Deno.test('consumes a permit on sender failure and releases the shared lock', async () => {
  const clock = new FakeClock(WINDOW_START, 0);
  const dependencies = createDependencies(clock);
  let sendCount = 0;

  await assertRejects(() =>
    executeGatedSourceSend(dependencies, () => {
      sendCount += 1;
      return Promise.reject(new Error('Synthetic transport failure'));
    })
  );

  const denied = await executeGatedSourceSend(dependencies, () => {
    sendCount += 1;
    return Promise.resolve('unexpected');
  });
  assertEquals(denied.status, 'denied');
  if (denied.status === 'denied') {
    assertEquals(denied.reason, 'permit-unavailable');
  }
  assertEquals(sendCount, 1);
});

class FakeClock implements SourceGateClock {
  constructor(public wallEpochMs: number, public monotonicMs: number) {}

  nowEpochMs(): number {
    return this.wallEpochMs;
  }

  nowMonotonicMs(): number {
    return this.monotonicMs;
  }
}

class SequencedClock implements SourceGateClock {
  #wallIndex = 0;
  #monotonicIndex = 0;

  constructor(
    private readonly wallValues: readonly number[],
    private readonly monotonicValues: readonly number[],
  ) {}

  nowEpochMs(): number {
    return this.readValue(this.wallValues, this.#wallIndex++);
  }

  nowMonotonicMs(): number {
    return this.readValue(this.monotonicValues, this.#monotonicIndex++);
  }

  private readValue(values: readonly number[], index: number): number {
    const value = values[index];
    if (value === undefined) {
      throw new Error('Fake clock sequence exhausted');
    }
    return value;
  }
}

function createDependencies(clock: SourceGateClock): SourceSendGateDependencies {
  const operatingWindowResult = createOperatingWindowGate([
    { startsAtEpochMs: WINDOW_START, endsAtEpochMs: WINDOW_END },
  ]);
  if (!operatingWindowResult.ok) {
    throw new Error(`Unexpected window configuration error: ${operatingWindowResult.error.code}`);
  }

  const permitResult = createMonotonicPermitGate(MIN_COLLECTION_INTERVAL_MS);
  if (!permitResult.ok) {
    throw new Error(`Unexpected permit configuration error: ${permitResult.error.code}`);
  }

  return Object.freeze({
    clock,
    operatingWindowGate: operatingWindowResult.gate,
    permitGate: permitResult.gate,
    operationLock: createSourceOperationLock(),
  });
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

async function assertRejects(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error('Expected promise to reject');
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
