import validResponse from './fixtures/arcgis-valid-response.json' with { type: 'json' };
import { buildArcGisCollectionUrl } from '../src/harvesting/arcgis-query.ts';
import { createArcGisClient, MAX_ARCGIS_RESPONSE_BYTES } from '../src/harvesting/arcgis-client.ts';
import type { ArcGisAttemptEvent, ArcGisEventSink } from '../src/telemetry/arcgis-events.ts';

const EXPECTED_ASSET_IDS = new Set(['TEST-001', 'TEST-002']);
const NOW_EPOCH_MS = 1782345900000;
const EXPECTED_URL = buildArcGisCollectionUrl().href;

Deno.test('ArcGIS client sends only the fixed request and validates a successful response', async () => {
  const events: ArcGisAttemptEvent[] = [];
  let capturedInput: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const fetcher: typeof fetch = (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return Promise.resolve(jsonResponse(validResponse, 200, { ETag: '"current"' }));
  };
  const client = createClient(fetcher, events);

  const result = await client.collect({ etag: '"prior"' });

  assert(result.ok && result.result === 'success', 'Expected a successful collection');
  assertEquals(result.collection.records.length, 2);
  assertEquals(result.etag, '"current"');
  assert(capturedInput instanceof URL);
  assertEquals(capturedInput.href, EXPECTED_URL);
  assertEquals(capturedInit?.method, 'GET');
  assertEquals(capturedInit?.redirect, 'manual');
  assert(capturedInit?.signal instanceof AbortSignal);
  const headers = new Headers(capturedInit?.headers);
  assertEquals(headers.get('accept'), 'application/json');
  assertEquals(headers.get('if-none-match'), '"prior"');
  assertEquals(events.length, 1);
  assertEquals(events[0]?.eventCode, 'arcgis.attempt.succeeded');
  assertEquals(events[0]?.acceptedRecordCount, 2);
});

Deno.test('ArcGIS client accepts an exact 304 without reading or validating a body', async () => {
  const events: ArcGisAttemptEvent[] = [];
  const client = createClient(
    () => Promise.resolve(responseAt(null, { status: 304 })),
    events,
  );

  const result = await client.collect();

  assert(result.ok && result.result === 'not-modified', 'Expected not modified');
  assertEquals(events.length, 1);
  assertEquals(events[0]?.result, 'not-modified');
  assertEquals(events[0]?.responseBytes, 0);
});

Deno.test('ArcGIS client rejects redirects and unexpected final URLs', async () => {
  await assertFailure(
    () => Promise.resolve(responseAt(null, { status: 302, headers: { Location: EXPECTED_URL } })),
    'redirect',
  );
  await assertFailure(
    () => Promise.resolve(jsonResponse(validResponse, 200, {}, 'https://example.invalid/')),
    'redirect',
  );
});

Deno.test('ArcGIS client classifies rejected status and content types', async () => {
  await assertFailure(() => Promise.resolve(responseAt(null, { status: 401 })), 'authorization');
  await assertFailure(() => Promise.resolve(responseAt(null, { status: 429 })), 'rate-limited');
  await assertFailure(
    () => Promise.resolve(responseAt(null, { status: 404 })),
    'http-client-error',
  );
  await assertFailure(
    () => Promise.resolve(responseAt(null, { status: 503 })),
    'http-server-error',
  );
  await assertFailure(
    () =>
      Promise.resolve(responseAt('{}', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    'content-type',
  );
});

Deno.test('ArcGIS client enforces declared and streamed response byte ceilings', async () => {
  await assertFailure(
    () =>
      Promise.resolve(responseAt('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_ARCGIS_RESPONSE_BYTES + 1),
        },
      })),
    'response-oversized',
  );

  const oversizedBody = new Uint8Array(MAX_ARCGIS_RESPONSE_BYTES + 1);
  await assertFailure(
    () =>
      Promise.resolve(responseAt(oversizedBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    'response-oversized',
  );
});

Deno.test('ArcGIS client rejects invalid JSON, ArcGIS errors, and validation failures', async () => {
  await assertFailure(
    () => Promise.resolve(responseAt('{', jsonResponseInit())),
    'validation',
    'rejected',
  );
  await assertFailure(
    () => Promise.resolve(jsonResponse({ error: { code: 500, message: 'Synthetic' } })),
    'arcgis-error',
    'rejected',
  );
  await assertFailure(
    () => Promise.resolve(jsonResponse({ features: [] })),
    'validation',
    'rejected',
  );
});

Deno.test('ArcGIS client classifies timeout, abort, and transport failures once', async () => {
  await assertFailure(
    () => Promise.reject(new DOMException('Synthetic timeout', 'TimeoutError')),
    'timeout',
  );
  await assertFailure(
    () => Promise.reject(new DOMException('Synthetic abort', 'AbortError')),
    'aborted',
  );
  await assertFailure(() => Promise.reject(new TypeError('Synthetic transport')), 'transport');
});

Deno.test('ArcGIS client ignores invalid validators and isolates telemetry failures', async () => {
  let sentEtag: string | null = 'not-captured';
  const fetcher: typeof fetch = (_input, init) => {
    sentEtag = new Headers(init?.headers).get('if-none-match');
    return Promise.resolve(jsonResponse(validResponse, 200, { ETag: 'unquoted' }));
  };
  const client = createArcGisClient({
    ...dependencies(fetcher, {
      emit: () => {
        throw new Error('Synthetic sink failure');
      },
    }),
  });

  const result = await client.collect({ etag: 'invalid' });

  assert(result.ok && result.result === 'success', 'Telemetry must not change collection');
  assertEquals(sentEtag, null);
  assert(!Object.hasOwn(result, 'etag'));
});

async function assertFailure(
  fetcher: typeof fetch,
  expectedFailureClass: string,
  expectedValidatorResult: 'not-evaluated' | 'rejected' = 'not-evaluated',
): Promise<void> {
  const events: ArcGisAttemptEvent[] = [];
  const result = await createClient(fetcher, events).collect();

  assert(!result.ok, 'Expected ArcGIS collection to fail');
  assertEquals(result.failureClass, expectedFailureClass);
  assertEquals(events.length, 1);
  assertEquals(events[0]?.eventCode, 'arcgis.attempt.failed');
  assertEquals(events[0]?.validatorResult, expectedValidatorResult);
  if (events[0]?.eventCode === 'arcgis.attempt.failed') {
    assertEquals(events[0].failureClass, expectedFailureClass);
  }
}

function createClient(fetcher: typeof fetch, events: ArcGisAttemptEvent[]) {
  return createArcGisClient(dependencies(fetcher, { emit: (event) => events.push(event) }));
}

function dependencies(fetcher: typeof fetch, eventSink: ArcGisEventSink) {
  let monotonicMs = 1_000;
  return {
    fetch: fetcher,
    eventSink,
    expectedAssetIds: EXPECTED_ASSET_IDS,
    pollTimeoutMs: 10_000,
    nowEpochMs: () => NOW_EPOCH_MS,
    nowMonotonicMs: () => monotonicMs += 5,
    createTimeoutSignal: () => new AbortController().signal,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
  url = EXPECTED_URL,
): Response {
  return responseAt(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  }, url);
}

function jsonResponseInit(): ResponseInit {
  return { status: 200, headers: { 'Content-Type': 'application/json' } };
}

function responseAt(
  body: BodyInit | null,
  init: ResponseInit,
  url = EXPECTED_URL,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
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
