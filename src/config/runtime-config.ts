import { MIN_COLLECTION_INTERVAL_MS } from '../harvesting/monotonic-permit-gate.ts';

const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_POLL_INTERVAL_SECONDS = MIN_COLLECTION_INTERVAL_MS / 1_000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_BACKOFF_SECONDS = 1_800;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEFAULT_CIRCUIT_INITIAL_BREAK_SECONDS = 1_800;
const MIN_HTTP_PORT = 1_024;
const MAX_HTTP_PORT = 65_535;
const MIN_POLL_TIMEOUT_SECONDS = 2;
const MAX_POLL_TIMEOUT_SECONDS = 30;
const MIN_CIRCUIT_FAILURE_THRESHOLD = 2;
const MAX_CIRCUIT_FAILURE_THRESHOLD = 10;
const MIN_CIRCUIT_BREAK_SECONDS = 300;
const MAX_CIRCUIT_BREAK_SECONDS = 86_400;
const MAX_SECONDS_WITH_SAFE_MILLISECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

export type RuntimeConfigurationVariable =
  | 'ARCGIS_EMERGENCY_DISABLED'
  | 'CIRCUIT_FAILURE_THRESHOLD'
  | 'CIRCUIT_INITIAL_BREAK_SECONDS'
  | 'HTTP_PORT'
  | 'MAX_BACKOFF_SECONDS'
  | 'POLL_ENABLED'
  | 'POLL_INTERVAL_SECONDS'
  | 'POLL_TIMEOUT_SECONDS';

export type RuntimeConfigurationErrorReason =
  | 'below-poll-interval'
  | 'invalid-boolean'
  | 'invalid-integer'
  | 'out-of-range';

export interface RuntimeConfiguration {
  readonly arcgisEmergencyDisabled: boolean;
  readonly circuitFailureThreshold: number;
  readonly circuitInitialBreakMs: number;
  readonly httpPort: number;
  readonly pollEnabled: boolean;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly maxBackoffMs: number;
}

export type RuntimeConfigurationResult =
  | Readonly<{ ok: true; value: RuntimeConfiguration }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      variable: RuntimeConfigurationVariable;
      reason: RuntimeConfigurationErrorReason;
    }>;
  }>;

/** Parses untrusted environment values without reading ambient process state. */
export function parseRuntimeConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfigurationResult {
  const httpPort = parseInteger(
    environment.HTTP_PORT,
    'HTTP_PORT',
    DEFAULT_HTTP_PORT,
    MIN_HTTP_PORT,
    MAX_HTTP_PORT,
  );
  if (!httpPort.ok) {
    return httpPort;
  }

  const pollEnabled = parseBoolean(environment.POLL_ENABLED, 'POLL_ENABLED', false);
  if (!pollEnabled.ok) {
    return pollEnabled;
  }

  const arcgisEmergencyDisabled = parseBoolean(
    environment.ARCGIS_EMERGENCY_DISABLED,
    'ARCGIS_EMERGENCY_DISABLED',
    false,
  );
  if (!arcgisEmergencyDisabled.ok) {
    return arcgisEmergencyDisabled;
  }

  const pollIntervalSeconds = parseInteger(
    environment.POLL_INTERVAL_SECONDS,
    'POLL_INTERVAL_SECONDS',
    DEFAULT_POLL_INTERVAL_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    MAX_SECONDS_WITH_SAFE_MILLISECONDS,
  );
  if (!pollIntervalSeconds.ok) {
    return pollIntervalSeconds;
  }

  const pollTimeoutSeconds = parseInteger(
    environment.POLL_TIMEOUT_SECONDS,
    'POLL_TIMEOUT_SECONDS',
    DEFAULT_POLL_TIMEOUT_SECONDS,
    MIN_POLL_TIMEOUT_SECONDS,
    MAX_POLL_TIMEOUT_SECONDS,
  );
  if (!pollTimeoutSeconds.ok) {
    return pollTimeoutSeconds;
  }

  const maxBackoffSeconds = parseInteger(
    environment.MAX_BACKOFF_SECONDS,
    'MAX_BACKOFF_SECONDS',
    DEFAULT_MAX_BACKOFF_SECONDS,
    1,
    MAX_SECONDS_WITH_SAFE_MILLISECONDS,
  );
  if (!maxBackoffSeconds.ok) {
    return maxBackoffSeconds;
  }
  if (maxBackoffSeconds.value < pollIntervalSeconds.value) {
    return failure('MAX_BACKOFF_SECONDS', 'below-poll-interval');
  }

  const circuitFailureThreshold = parseInteger(
    environment.CIRCUIT_FAILURE_THRESHOLD,
    'CIRCUIT_FAILURE_THRESHOLD',
    DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    MIN_CIRCUIT_FAILURE_THRESHOLD,
    MAX_CIRCUIT_FAILURE_THRESHOLD,
  );
  if (!circuitFailureThreshold.ok) {
    return circuitFailureThreshold;
  }

  const circuitInitialBreakSeconds = parseInteger(
    environment.CIRCUIT_INITIAL_BREAK_SECONDS,
    'CIRCUIT_INITIAL_BREAK_SECONDS',
    DEFAULT_CIRCUIT_INITIAL_BREAK_SECONDS,
    MIN_CIRCUIT_BREAK_SECONDS,
    MAX_CIRCUIT_BREAK_SECONDS,
  );
  if (!circuitInitialBreakSeconds.ok) {
    return circuitInitialBreakSeconds;
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      httpPort: httpPort.value,
      pollEnabled: pollEnabled.value,
      arcgisEmergencyDisabled: arcgisEmergencyDisabled.value,
      pollIntervalMs: pollIntervalSeconds.value * 1_000,
      pollTimeoutMs: pollTimeoutSeconds.value * 1_000,
      maxBackoffMs: maxBackoffSeconds.value * 1_000,
      circuitFailureThreshold: circuitFailureThreshold.value,
      circuitInitialBreakMs: circuitInitialBreakSeconds.value * 1_000,
    }),
  });
}

type ParsedValue<T> =
  | Readonly<{ ok: true; value: T }>
  | Extract<RuntimeConfigurationResult, { ok: false }>;

function parseBoolean(
  input: string | undefined,
  variable: RuntimeConfigurationVariable,
  defaultValue: boolean,
): ParsedValue<boolean> {
  if (input === undefined) {
    return Object.freeze({ ok: true, value: defaultValue });
  }
  if (input === 'true') {
    return Object.freeze({ ok: true, value: true });
  }
  if (input === 'false') {
    return Object.freeze({ ok: true, value: false });
  }
  return failure(variable, 'invalid-boolean');
}

function parseInteger(
  input: string | undefined,
  variable: RuntimeConfigurationVariable,
  defaultValue: number,
  minimum: number,
  maximum: number,
): ParsedValue<number> {
  if (input === undefined) {
    return Object.freeze({ ok: true, value: defaultValue });
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(input)) {
    return failure(variable, 'invalid-integer');
  }

  const value = Number(input);
  if (!Number.isSafeInteger(value)) {
    return failure(variable, 'invalid-integer');
  }
  if (value < minimum || value > maximum) {
    return failure(variable, 'out-of-range');
  }
  return Object.freeze({ ok: true, value });
}

function failure(
  variable: RuntimeConfigurationVariable,
  reason: RuntimeConfigurationErrorReason,
): Extract<RuntimeConfigurationResult, { ok: false }> {
  return Object.freeze({ ok: false, error: Object.freeze({ variable, reason }) });
}
