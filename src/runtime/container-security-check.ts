export const CONTAINER_SECURITY_CHECK_ARGUMENT = '--container-security-check' as const;

export type ContainerPermissionState = Deno.PermissionState | 'error';

export interface ContainerSecurityCheckResult {
  readonly code: string;
  readonly expected: Deno.PermissionState;
  readonly actual: ContainerPermissionState;
  readonly passed: boolean;
}

export interface ContainerSecurityReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly checks: readonly ContainerSecurityCheckResult[];
}

export type PermissionQuery = (
  descriptor: Deno.PermissionDescriptor,
) => Promise<Readonly<{ state: Deno.PermissionState }>>;

interface PermissionExpectation {
  readonly code: string;
  readonly descriptor: Deno.PermissionDescriptor;
  readonly expected: Deno.PermissionState;
}

const EXPECTATIONS: readonly PermissionExpectation[] = Object.freeze([
  granted('env.arcgis-emergency-disabled', {
    name: 'env',
    variable: 'ARCGIS_EMERGENCY_DISABLED',
  }),
  granted('env.circuit-failure-threshold', {
    name: 'env',
    variable: 'CIRCUIT_FAILURE_THRESHOLD',
  }),
  granted('env.circuit-initial-break-seconds', {
    name: 'env',
    variable: 'CIRCUIT_INITIAL_BREAK_SECONDS',
  }),
  granted('env.http-port', { name: 'env', variable: 'HTTP_PORT' }),
  granted('env.max-backoff-seconds', { name: 'env', variable: 'MAX_BACKOFF_SECONDS' }),
  granted('env.poll-enabled', { name: 'env', variable: 'POLL_ENABLED' }),
  granted('env.poll-interval-seconds', { name: 'env', variable: 'POLL_INTERVAL_SECONDS' }),
  granted('env.poll-timeout-seconds', { name: 'env', variable: 'POLL_TIMEOUT_SECONDS' }),
  granted('net.listener', { name: 'net', host: '0.0.0.0:8080' }),
  granted('net.arcgis', { name: 'net', host: 'services8.arcgis.com:443' }),
  prompt('env.unapproved', { name: 'env', variable: 'PATH' }),
  prompt('net.unapproved', { name: 'net', host: 'example.invalid:443' }),
  denied('read.filesystem', { name: 'read' }),
  denied('write.filesystem', { name: 'write' }),
  denied('run.subprocess', { name: 'run' }),
  denied('ffi.dynamic-library', { name: 'ffi' }),
  denied('sys.hostname', { name: 'sys', kind: 'hostname' }),
]);

/** Reports only bounded permission states; it performs no file, process, FFI, or network action. */
export async function inspectContainerSecurity(
  query: PermissionQuery = (descriptor) => Deno.permissions.query(descriptor),
): Promise<ContainerSecurityReport> {
  const checks: ContainerSecurityCheckResult[] = [];
  for (const expectation of EXPECTATIONS) {
    let actual: ContainerPermissionState;
    try {
      actual = (await query(expectation.descriptor)).state;
    } catch {
      actual = 'error';
    }
    checks.push(Object.freeze({
      code: expectation.code,
      expected: expectation.expected,
      actual,
      passed: actual === expectation.expected,
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    ok: checks.every((check) => check.passed),
    checks: Object.freeze(checks),
  });
}

function granted(code: string, descriptor: Deno.PermissionDescriptor): PermissionExpectation {
  return Object.freeze({ code, descriptor, expected: 'granted' });
}

function denied(code: string, descriptor: Deno.PermissionDescriptor): PermissionExpectation {
  return Object.freeze({ code, descriptor, expected: 'denied' });
}

function prompt(code: string, descriptor: Deno.PermissionDescriptor): PermissionExpectation {
  return Object.freeze({ code, descriptor, expected: 'prompt' });
}
