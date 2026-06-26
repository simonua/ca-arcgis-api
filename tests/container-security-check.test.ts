import {
  inspectContainerSecurity,
  type PermissionQuery,
} from '../src/runtime/container-security-check.ts';

const ALLOWED_ENVIRONMENT = new Set([
  'ARCGIS_EMERGENCY_DISABLED',
  'CIRCUIT_FAILURE_THRESHOLD',
  'CIRCUIT_INITIAL_BREAK_SECONDS',
  'HTTP_PORT',
  'MAX_BACKOFF_SECONDS',
  'POLL_ENABLED',
  'POLL_INTERVAL_SECONDS',
  'POLL_TIMEOUT_SECONDS',
]);
const ALLOWED_NETWORK = new Set(['0.0.0.0:8080', 'services8.arcgis.com:443']);

Deno.test('container security report accepts only the compiled permission allowlist', async () => {
  const report = await inspectContainerSecurity(fakeCompiledPermissionQuery());

  assert(report.ok);
  assertEquals(report.schemaVersion, 1);
  assertEquals(report.checks.length, 17);
  assertEquals(report.checks.every((check) => check.passed), true);
  const serialized = JSON.stringify(report);
  for (
    const forbidden of ['/etc/passwd', '/tmp/container-security-check', '/bin/sh', 'libc.so.6']
  ) {
    assertEquals(serialized.includes(forbidden), false);
  }
});

Deno.test('container security report fails closed on missing grants and query errors', async () => {
  const query = fakeCompiledPermissionQuery({ listenerState: 'denied', throwOnSys: true });

  const report = await inspectContainerSecurity(query);

  assertEquals(report.ok, false);
  assertEquals(result(report, 'net.listener').actual, 'denied');
  assertEquals(result(report, 'sys.hostname').actual, 'error');
});

function fakeCompiledPermissionQuery(
  options: Readonly<{
    listenerState?: Deno.PermissionState;
    throwOnSys?: boolean;
  }> = {},
): PermissionQuery {
  return (descriptor) => {
    if (descriptor.name === 'sys' && options.throwOnSys === true) {
      throw new Error('synthetic permission query failure');
    }
    if (descriptor.name === 'env') {
      return Promise.resolve({
        state: descriptor.variable !== undefined && ALLOWED_ENVIRONMENT.has(descriptor.variable)
          ? 'granted'
          : 'prompt',
      });
    }
    if (descriptor.name === 'net') {
      const state = descriptor.host === '0.0.0.0:8080' && options.listenerState !== undefined
        ? options.listenerState
        : descriptor.host !== undefined && ALLOWED_NETWORK.has(descriptor.host)
        ? 'granted'
        : 'prompt';
      return Promise.resolve({ state });
    }
    return Promise.resolve({ state: 'denied' });
  };
}

function result(
  report: Awaited<ReturnType<typeof inspectContainerSecurity>>,
  code: string,
) {
  const check = report.checks.find((candidate) => candidate.code === code);
  if (check === undefined) {
    throw new Error(`Missing check: ${code}`);
  }
  return check;
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
