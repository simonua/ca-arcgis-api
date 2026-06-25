export const ARCGIS_EVENT_SCHEMA_VERSION = 1 as const;

export type ArcGisOperation = 'collection' | 'metadata' | 'restricted-diagnostic';

export type ArcGisFailureClass =
  | 'aborted'
  | 'arcgis-error'
  | 'authorization'
  | 'content-type'
  | 'http-client-error'
  | 'http-server-error'
  | 'rate-limited'
  | 'redirect'
  | 'response-oversized'
  | 'timeout'
  | 'transport'
  | 'validation';

interface ArcGisAttemptEventBase {
  readonly schemaVersion: typeof ARCGIS_EVENT_SCHEMA_VERSION;
  readonly occurredAt: string;
  readonly operation: ArcGisOperation;
  readonly durationMs: number;
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly acceptedRecordCount?: number;
  readonly rejectedRecordCount?: number;
  readonly consecutiveFailures: number;
}

export interface ArcGisAttemptSucceededEvent extends ArcGisAttemptEventBase {
  readonly eventCode: 'arcgis.attempt.succeeded';
  readonly level: 'info';
  readonly result: 'success' | 'not-modified';
  readonly validatorResult: 'accepted' | 'not-evaluated';
}

export interface ArcGisAttemptFailedEvent extends ArcGisAttemptEventBase {
  readonly eventCode: 'arcgis.attempt.failed';
  readonly level: 'warn' | 'error';
  readonly result: 'failure';
  readonly failureClass: ArcGisFailureClass;
  readonly validatorResult: 'not-evaluated' | 'rejected';
}

/** Safe, bounded evidence for one actual ArcGIS HTTP attempt. */
export type ArcGisAttemptEvent = ArcGisAttemptSucceededEvent | ArcGisAttemptFailedEvent;

export interface ArcGisEventSink {
  emit(event: ArcGisAttemptEvent): void;
}

export type ArcGisEventLineWriter = (
  level: ArcGisAttemptEvent['level'],
  line: string,
) => void;

/**
 * Serializes operational events without allowing telemetry failures to affect source collection.
 * Retention and rotation belong to the deployment log sink, not the application process.
 */
export function createJsonLineArcGisEventSink(writeLine: ArcGisEventLineWriter): ArcGisEventSink {
  return Object.freeze({
    emit(event: ArcGisAttemptEvent): void {
      try {
        writeLine(event.level, JSON.stringify(event));
      } catch {
        // Telemetry is deliberately outside source-request control flow.
      }
    },
  });
}

/** Production console output is collected and retained by the deployment platform. */
export function createConsoleArcGisEventSink(): ArcGisEventSink {
  return createJsonLineArcGisEventSink((level, line) => {
    if (level === 'error') {
      console.error(line);
      return;
    }
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.info(line);
  });
}
