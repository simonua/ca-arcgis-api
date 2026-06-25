import {
  ARCGIS_EVENT_SCHEMA_VERSION,
  type ArcGisAttemptEvent,
  createJsonLineArcGisEventSink,
} from '../src/telemetry/arcgis-events.ts';

Deno.test('writes one bounded JSON event for a successful ArcGIS attempt', () => {
  const lines: string[] = [];
  const sink = createJsonLineArcGisEventSink((_level, line) => lines.push(line));

  sink.emit(successEvent());

  assertEquals(lines.length, 1);
  const parsed = parseEvent(lines[0]);
  assertEquals(parsed.schemaVersion, ARCGIS_EVENT_SCHEMA_VERSION);
  assertEquals(parsed.eventCode, 'arcgis.attempt.succeeded');
  assertEquals(parsed.result, 'success');
  assertEquals(parsed.httpStatus, 200);
  assert(!Object.hasOwn(parsed, 'url'));
  assert(!Object.hasOwn(parsed, 'query'));
  assert(!Object.hasOwn(parsed, 'payload'));
});

Deno.test('writes stable failure evidence without exception or response details', () => {
  const output: Array<{ level: string; line: string }> = [];
  const sink = createJsonLineArcGisEventSink((level, line) => output.push({ level, line }));
  const event: ArcGisAttemptEvent = Object.freeze({
    schemaVersion: ARCGIS_EVENT_SCHEMA_VERSION,
    eventCode: 'arcgis.attempt.failed',
    level: 'warn',
    result: 'failure',
    occurredAt: '2026-06-25T15:10:00.000Z',
    operation: 'collection',
    durationMs: 10000,
    failureClass: 'timeout',
    validatorResult: 'not-evaluated',
    rejectedRecordCount: 0,
    consecutiveFailures: 2,
  });

  sink.emit(event);

  assertEquals(output.length, 1);
  assertEquals(output[0]?.level, 'warn');
  const parsed = parseEvent(output[0]?.line);
  assertEquals(parsed.failureClass, 'timeout');
  assertEquals(parsed.consecutiveFailures, 2);
  assert(!Object.hasOwn(parsed, 'message'));
  assert(!Object.hasOwn(parsed, 'stack'));
  assert(!Object.hasOwn(parsed, 'responseBody'));
});

Deno.test('does not let a log writer failure escape into collection control flow', () => {
  const sink = createJsonLineArcGisEventSink(() => {
    throw new Error('Synthetic writer failure');
  });

  sink.emit(successEvent());
});

function successEvent(): ArcGisAttemptEvent {
  return Object.freeze({
    schemaVersion: ARCGIS_EVENT_SCHEMA_VERSION,
    eventCode: 'arcgis.attempt.succeeded',
    level: 'info',
    result: 'success',
    occurredAt: '2026-06-25T15:05:00.000Z',
    operation: 'collection',
    durationMs: 125,
    httpStatus: 200,
    responseBytes: 4096,
    validatorResult: 'accepted',
    acceptedRecordCount: 2,
    rejectedRecordCount: 0,
    consecutiveFailures: 0,
  });
}

function parseEvent(line: string | undefined): Record<string, unknown> {
  if (line === undefined) {
    throw new Error('Expected a JSON event line');
  }
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON event object');
  }
  return parsed as Record<string, unknown>;
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
