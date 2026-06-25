import type { CollectionSchedulerRunner } from '../src/harvesting/collection-scheduler-runner.ts';
import type { SemanticFreshnessProjector } from '../src/freshness/semantic-freshness-projector.ts';
import type { ApiRequestHandler } from '../src/http/api-handler.ts';
import { createSnapshotStore } from '../src/snapshot/snapshot-store.ts';
import { composeApiRuntime } from '../src/runtime/api-runtime-composition.ts';
import { type ApiRuntimeServerFactory, createApiRuntime } from '../src/runtime/api-runtime.ts';

Deno.test('API runtime starts server before scheduler and stops scheduler before drain', async () => {
  const events: string[] = [];
  const finished = Promise.resolve();
  const runtime = createApiRuntime({
    handler: noOpHandler,
    serverFactory: serverFactory(events, finished),
    schedulerRunner: scheduler(events),
  });

  runtime.start();
  runtime.start();
  assertEquals(events.join(','), 'server-start,scheduler-start');
  assertSame(runtime.finished(), finished);

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assertSame(firstStop, secondStop);
  await firstStop;
  assertEquals(events.join(','), 'server-start,scheduler-start,scheduler-stop,server-shutdown');
});

Deno.test('API runtime can serve a snapshot-only process without a scheduler', async () => {
  const events: string[] = [];
  const runtime = createApiRuntime({
    handler: noOpHandler,
    serverFactory: serverFactory(events, Promise.resolve()),
  });

  runtime.start();
  await runtime.stop();

  assertEquals(events.join(','), 'server-start,server-shutdown');
});

Deno.test('API runtime does not start scheduling when server startup fails', () => {
  const events: string[] = [];
  const runtime = createApiRuntime({
    handler: noOpHandler,
    serverFactory: Object.freeze({
      start(): never {
        events.push('server-start');
        throw new Error('synthetic startup failure');
      },
    }),
    schedulerRunner: scheduler(events),
  });

  let threw = false;
  try {
    runtime.start();
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(events.join(','), 'server-start');
});

Deno.test('API runtime composition rejects invalid bounded state before startup', () => {
  const invalidCache = composeApiRuntime(
    compositionOptions({ maxEntries: 0, maxBytes: 4_096 }),
  );
  assert(!invalidCache.ok);
  assertEquals(invalidCache.error.code, 'invalid-response-cache-config');

  const invalidLimiter = composeApiRuntime(compositionOptions(undefined, 0));
  assert(!invalidLimiter.ok);
  assertEquals(invalidLimiter.error.code, 'invalid-rate-limit-config');
});

Deno.test('API runtime composition assembles a permission-free liveness path', async () => {
  const events: string[] = [];
  const composed = composeApiRuntime(compositionOptions(undefined, 10, events));
  assert(composed.ok);

  const response = await composed.handler(new Request('https://api.example.test/healthz'));
  assertEquals(response.status, 200);
  composed.runtime.start();
  await composed.runtime.stop();
  assertEquals(events.join(','), 'server-start,server-shutdown');
});

const noOpHandler: ApiRequestHandler = () => Promise.resolve(new Response(null, { status: 204 }));

const unavailableProjector: SemanticFreshnessProjector = Object.freeze({
  project: () =>
    Object.freeze({
      ok: true as const,
      value: Object.freeze({
        snapshotState: 'unavailable' as const,
        collectionState: 'active' as const,
        pools: Object.freeze([]),
      }),
    }),
});

function compositionOptions(
  responseCache: Readonly<{ maxEntries: number; maxBytes: number }> | undefined = undefined,
  requestsPerWindow = 10,
  events: string[] = [],
): Parameters<typeof composeApiRuntime>[0] {
  return Object.freeze({
    snapshotStore: createSnapshotStore(),
    freshnessProjector: unavailableProjector,
    knownPoolIds: Object.freeze([]),
    allowedOrigins: Object.freeze([]),
    responseCache: responseCache ?? Object.freeze({ maxEntries: 4, maxBytes: 4_096 }),
    inboundRateLimit: Object.freeze({
      requestsPerWindow,
      windowMs: 60_000,
      maxClientPartitions: 16,
    }),
    nowEpochMs: () => 0,
    nowMonotonicMs: () => 0,
    openApiEnabled: true,
    serverFactory: serverFactory(events, Promise.resolve()),
  });
}

function serverFactory(
  events: string[],
  finished: Promise<void>,
): ApiRuntimeServerFactory {
  return Object.freeze({
    start(): ReturnType<ApiRuntimeServerFactory['start']> {
      events.push('server-start');
      return Object.freeze({
        finished,
        shutdown(): Promise<void> {
          events.push('server-shutdown');
          return Promise.resolve();
        },
      });
    },
  });
}

function scheduler(events: string[]): CollectionSchedulerRunner {
  return Object.freeze({
    start(): void {
      events.push('scheduler-start');
    },
    stop(): void {
      events.push('scheduler-stop');
    },
  });
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

function assertSame(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error('Expected references to be identical');
  }
}
