import type { ArcGisSourceCollection } from '../contracts/arcgis-source.ts';
import {
  ARCGIS_EVENT_SCHEMA_VERSION,
  type ArcGisAttemptEvent,
  type ArcGisEventSink,
  type ArcGisFailureClass,
} from '../telemetry/arcgis-events.ts';
import { buildArcGisCollectionUrl } from './arcgis-query.ts';
import { validateArcGisSourceResponse } from './source-validator.ts';

export const MAX_ARCGIS_RESPONSE_BYTES = 262_144 as const;

const MAX_ETAG_LENGTH = 256;
const ETAG_PATTERN = /^(?:W\/)?"[!#-~]*"$/;

export type ArcGisCollectionResult =
  | Readonly<{
    ok: true;
    result: 'success';
    collection: ArcGisSourceCollection;
    etag?: string;
  }>
  | Readonly<{ ok: true; result: 'not-modified' }>
  | Readonly<{ ok: false; failureClass: ArcGisFailureClass }>;

export interface ArcGisCollectionRequest {
  readonly etag?: string;
}

export interface ArcGisClient {
  collect(request?: ArcGisCollectionRequest): Promise<ArcGisCollectionResult>;
}

export interface ArcGisClientDependencies {
  readonly fetch: typeof fetch;
  readonly eventSink: ArcGisEventSink;
  readonly expectedAssetIds: ReadonlySet<string>;
  readonly pollTimeoutMs: number;
  readonly nowEpochMs: () => number;
  readonly nowMonotonicMs: () => number;
  readonly createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
}

type ArcGisAttemptEventDetails<Event extends ArcGisAttemptEvent = ArcGisAttemptEvent> =
  Event extends ArcGisAttemptEvent ? Omit<
      Event,
      'schemaVersion' | 'occurredAt' | 'operation' | 'durationMs' | 'consecutiveFailures'
    >
    : never;

/** Creates a fixed-request client intended to run only as the P0 source sender. */
export function createArcGisClient(dependencies: ArcGisClientDependencies): ArcGisClient {
  const createTimeoutSignal = dependencies.createTimeoutSignal ?? AbortSignal.timeout;
  let consecutiveFailures = 0;

  return Object.freeze({
    async collect(request: ArcGisCollectionRequest = {}): Promise<ArcGisCollectionResult> {
      const url = buildArcGisCollectionUrl();
      const startedAtEpochMs = dependencies.nowEpochMs();
      const startedAtMonotonicMs = dependencies.nowMonotonicMs();
      const signal = createTimeoutSignal(dependencies.pollTimeoutMs);
      const headers = new Headers({ Accept: 'application/json' });
      const requestEtag = readValidEtag(request.etag);
      if (requestEtag !== undefined) {
        headers.set('If-None-Match', requestEtag);
      }

      let response: Response;
      try {
        response = await dependencies.fetch(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal,
        });
      } catch (error: unknown) {
        return fail(classifyThrownFailure(error, signal));
      }

      const responseBytesHeader = readContentLength(response.headers.get('content-length'));
      if (isRedirectStatus(response.status) || response.url !== url.href) {
        return fail('redirect', response.status, responseBytesHeader);
      }
      if (response.status === 304) {
        consecutiveFailures = 0;
        emit({
          eventCode: 'arcgis.attempt.succeeded',
          level: 'info',
          result: 'not-modified',
          validatorResult: 'not-evaluated',
          httpStatus: response.status,
          responseBytes: 0,
        });
        return Object.freeze({ ok: true, result: 'not-modified' });
      }
      if (response.status === 401 || response.status === 403) {
        return fail('authorization', response.status, responseBytesHeader);
      }
      if (response.status === 429) {
        return fail('rate-limited', response.status, responseBytesHeader);
      }
      if (response.status >= 500) {
        return fail('http-server-error', response.status, responseBytesHeader);
      }
      if (response.status < 200 || response.status >= 300) {
        return fail('http-client-error', response.status, responseBytesHeader);
      }
      if (!isJsonContentType(response.headers.get('content-type'))) {
        return fail('content-type', response.status, responseBytesHeader);
      }
      if (
        responseBytesHeader !== undefined && responseBytesHeader > MAX_ARCGIS_RESPONSE_BYTES
      ) {
        return fail('response-oversized', response.status, responseBytesHeader);
      }

      let body: Uint8Array;
      try {
        const bodyResult = await readBoundedBody(response, MAX_ARCGIS_RESPONSE_BYTES);
        if (!bodyResult.ok) {
          return fail('response-oversized', response.status, bodyResult.responseBytes);
        }
        body = bodyResult.body;
      } catch (error: unknown) {
        return fail(classifyThrownFailure(error, signal), response.status);
      }

      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        return fail('validation', response.status, body.byteLength, 'rejected');
      }

      const validation = validateArcGisSourceResponse(input, {
        expectedAssetIds: dependencies.expectedAssetIds,
        nowEpochMs: dependencies.nowEpochMs(),
      });
      if (!validation.ok) {
        const failureClass = validation.error.code === 'arcgis_error'
          ? 'arcgis-error'
          : 'validation';
        return fail(failureClass, response.status, body.byteLength, 'rejected');
      }

      consecutiveFailures = 0;
      const responseEtag = readValidEtag(response.headers.get('etag') ?? undefined);
      emit({
        eventCode: 'arcgis.attempt.succeeded',
        level: 'info',
        result: 'success',
        validatorResult: 'accepted',
        httpStatus: response.status,
        responseBytes: body.byteLength,
        acceptedRecordCount: validation.value.records.length,
        rejectedRecordCount: 0,
      });
      return Object.freeze({
        ok: true,
        result: 'success',
        collection: validation.value,
        ...(responseEtag === undefined ? {} : { etag: responseEtag }),
      });

      function fail(
        failureClass: ArcGisFailureClass,
        httpStatus?: number,
        responseBytes?: number,
        validatorResult: 'not-evaluated' | 'rejected' = 'not-evaluated',
      ): ArcGisCollectionResult {
        consecutiveFailures += 1;
        emit({
          eventCode: 'arcgis.attempt.failed',
          level: failureLevel(failureClass),
          result: 'failure',
          failureClass,
          validatorResult,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(responseBytes === undefined ? {} : { responseBytes }),
        });
        return Object.freeze({ ok: false, failureClass });
      }

      function emit(event: ArcGisAttemptEventDetails): void {
        const durationMs = boundedDuration(startedAtMonotonicMs, dependencies.nowMonotonicMs());
        const attemptEvent = Object.freeze({
          schemaVersion: ARCGIS_EVENT_SCHEMA_VERSION,
          occurredAt: toIsoString(startedAtEpochMs),
          operation: 'collection' as const,
          durationMs,
          consecutiveFailures,
          ...event,
        }) as ArcGisAttemptEvent;
        try {
          dependencies.eventSink.emit(attemptEvent);
        } catch {
          // Telemetry is deliberately outside source-request control flow.
        }
      }
    },
  });
}

type BoundedBodyResult =
  | Readonly<{ ok: true; body: Uint8Array }>
  | Readonly<{ ok: false; responseBytes: number }>;

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<BoundedBodyResult> {
  if (response.body === null) {
    return Object.freeze({ ok: true, body: new Uint8Array() });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    responseBytes += chunk.value.byteLength;
    if (responseBytes > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort after the response is already rejected.
      }
      return Object.freeze({ ok: false, responseBytes });
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(responseBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ ok: true, body });
}

function classifyThrownFailure(error: unknown, signal: AbortSignal): ArcGisFailureClass {
  if (
    isDomExceptionNamed(error, 'TimeoutError') || isDomExceptionNamed(signal.reason, 'TimeoutError')
  ) {
    return 'timeout';
  }
  if (isDomExceptionNamed(error, 'AbortError') || signal.aborted) {
    return 'aborted';
  }
  return 'transport';
}

function isDomExceptionNamed(value: unknown, name: string): boolean {
  return value instanceof DOMException && value.name === name;
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function readContentLength(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readValidEtag(value: string | undefined): string | undefined {
  if (value === undefined || value.length > MAX_ETAG_LENGTH || !ETAG_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

function failureLevel(failureClass: ArcGisFailureClass): 'warn' | 'error' {
  switch (failureClass) {
    case 'authorization':
    case 'content-type':
    case 'redirect':
    case 'response-oversized':
    case 'validation':
      return 'error';
    default:
      return 'warn';
  }
}

function boundedDuration(startedAt: number, endedAt: number): number {
  const duration = endedAt - startedAt;
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
}

function toIsoString(epochMs: number): string {
  const date = new Date(epochMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}
