const MAX_IMAGE_BYTES = 150 * 1024 * 1024;
const EXPECTED_PERMISSION_CODES = Object.freeze([
  'env.arcgis-emergency-disabled',
  'env.circuit-failure-threshold',
  'env.circuit-initial-break-seconds',
  'env.http-port',
  'env.max-backoff-seconds',
  'env.poll-enabled',
  'env.poll-interval-seconds',
  'env.poll-timeout-seconds',
  'net.listener',
  'net.arcgis',
  'env.unapproved',
  'net.unapproved',
  'read.filesystem',
  'write.filesystem',
  'run.subprocess',
  'ffi.dynamic-library',
  'sys.hostname',
]);
const FORBIDDEN_PATHS = Object.freeze([
  '/bin/sh',
  '/bin/bash',
  '/busybox/sh',
  '/usr/bin/apt',
  '/usr/bin/apt-get',
  '/usr/bin/dpkg',
  '/sbin/apk',
  '/usr/bin/curl',
  '/usr/bin/wget',
  '/usr/bin/deno',
  '/deno',
  '/workspace',
  '/src',
  '/config',
]);

interface DockerImageInspect {
  readonly Architecture: string;
  readonly Os: string;
  readonly Size: number;
  readonly Config: {
    readonly User?: string;
    readonly Entrypoint?: readonly string[] | null;
    readonly Cmd?: readonly string[] | null;
    readonly ExposedPorts?: Readonly<Record<string, unknown>> | null;
    readonly Env?: readonly string[] | null;
    readonly Healthcheck?: unknown;
    readonly Volumes?: Readonly<Record<string, unknown>> | null;
    readonly StopSignal?: string;
  };
}

interface PermissionCheck {
  readonly code: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

interface PermissionReport {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly checks: readonly PermissionCheck[];
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function verifyContainerImage(image: string): Promise<void> {
  const failures: string[] = [];
  const inspectResult = await captureDocker(['image', 'inspect', image]);
  requireSuccess(inspectResult, 'docker image inspect');
  const inspect = parseImageInspect(inspectResult.stdout);

  expect(
    inspect.Os === 'linux',
    `operating system must be linux, received ${inspect.Os}`,
    failures,
  );
  expect(
    inspect.Architecture === 'amd64',
    `architecture must be amd64, received ${inspect.Architecture}`,
    failures,
  );
  expect(
    inspect.Config.User === '65532:65532',
    `runtime user must be 65532:65532, received ${String(inspect.Config.User)}`,
    failures,
  );
  expect(
    equals(inspect.Config.Entrypoint, ['/ca-arcgis-api']),
    `entrypoint must contain only /ca-arcgis-api`,
    failures,
  );
  expect(
    inspect.Config.Cmd === null || inspect.Config.Cmd === undefined,
    'runtime command must be empty',
    failures,
  );
  expect(
    inspect.Config.ExposedPorts !== undefined &&
      inspect.Config.ExposedPorts !== null &&
      Object.keys(inspect.Config.ExposedPorts).length === 1 &&
      Object.hasOwn(inspect.Config.ExposedPorts, '8080/tcp'),
    'only 8080/tcp may be exposed',
    failures,
  );
  expect(
    inspect.Config.Healthcheck === undefined || inspect.Config.Healthcheck === null,
    'image must not embed a utility-based health check',
    failures,
  );
  expect(
    inspect.Config.Volumes === undefined || inspect.Config.Volumes === null,
    'image must not declare writable volumes',
    failures,
  );
  expect(inspect.Config.StopSignal === 'SIGTERM', 'stop signal must be SIGTERM', failures);
  expect(
    Number.isFinite(inspect.Size) && inspect.Size <= MAX_IMAGE_BYTES,
    `image size ${inspect.Size} exceeds ${MAX_IMAGE_BYTES} bytes`,
    failures,
  );
  for (const requiredEnvironment of ['DENO_NO_PROMPT=1', 'DENO_NO_UPDATE_CHECK=1']) {
    expect(
      inspect.Config.Env?.includes(requiredEnvironment) === true,
      `missing runtime environment guard ${requiredEnvironment}`,
      failures,
    );
  }

  const containerName = `ca-arcgis-api-verify-${crypto.randomUUID()}`;
  const createResult = await captureDocker([
    'create',
    '--name',
    containerName,
    '--network=none',
    image,
    '--container-security-check',
  ]);
  requireSuccess(createResult, 'docker create');
  try {
    for (const path of FORBIDDEN_PATHS) {
      const copyResult = await statusDocker(['cp', `${containerName}:${path}`, '-']);
      expect(copyResult.code !== 0, `forbidden runtime path exists: ${path}`, failures);
    }
  } finally {
    const removeResult = await captureDocker(['rm', '--force', containerName]);
    requireSuccess(removeResult, 'docker rm');
  }

  const securityResult = await captureDocker([
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=256m',
    '--user=65532:65532',
    image,
    '--container-security-check',
  ]);
  requireSuccess(securityResult, 'hardened container security check');
  const report = parsePermissionReport(securityResult.stdout);
  expect(report.schemaVersion === 1, 'permission report schema version must be 1', failures);
  expect(report.ok, 'compiled permission report did not pass', failures);
  expect(
    equals(
      report.checks.map((check) => check.code),
      EXPECTED_PERMISSION_CODES,
    ),
    'compiled permission report has missing, extra, or reordered checks',
    failures,
  );
  for (const check of report.checks) {
    expect(
      check.passed && check.actual === check.expected,
      `permission check failed: ${check.code}`,
      failures,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Container verification failed:\n- ${failures.join('\n- ')}`);
  }
  console.log(
    JSON.stringify({
      image,
      ok: true,
      architecture: inspect.Architecture,
      sizeBytes: inspect.Size,
      user: inspect.Config.User,
      permissionChecks: report.checks.length,
      forbiddenPathsChecked: FORBIDDEN_PATHS.length,
    }),
  );
}

function parseImageInspect(value: string): DockerImageInspect {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error('Docker returned an invalid image inspection document.');
  }
  const image = parsed[0];
  if (
    typeof image.Architecture !== 'string' ||
    typeof image.Os !== 'string' ||
    typeof image.Size !== 'number' ||
    !isRecord(image.Config)
  ) {
    throw new Error('Docker image inspection is missing required fields.');
  }
  return image as unknown as DockerImageInspect;
}

function parsePermissionReport(value: string): PermissionReport {
  const parsed: unknown = JSON.parse(value.trim());
  if (
    !isRecord(parsed) ||
    typeof parsed.schemaVersion !== 'number' ||
    typeof parsed.ok !== 'boolean' ||
    !Array.isArray(parsed.checks)
  ) {
    throw new Error('Container returned an invalid permission report.');
  }
  for (const candidate of parsed.checks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.code !== 'string' ||
      typeof candidate.expected !== 'string' ||
      typeof candidate.actual !== 'string' ||
      typeof candidate.passed !== 'boolean'
    ) {
      throw new Error('Container permission report contains an invalid check.');
    }
  }
  return parsed as unknown as PermissionReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equals(
  actual: readonly string[] | null | undefined,
  expected: readonly string[],
): boolean {
  return actual !== null &&
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function expect(condition: boolean, message: string, failures: string[]): void {
  if (!condition) {
    failures.push(message);
  }
}

async function captureDocker(args: readonly string[]): Promise<CommandResult> {
  const output = await new Deno.Command('docker', {
    args: [...args],
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return Object.freeze({
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  });
}

async function statusDocker(args: readonly string[]): Promise<Readonly<{ code: number }>> {
  const child = new Deno.Command('docker', {
    args: [...args],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  const status = await child.status;
  return Object.freeze({ code: status.code });
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(0, 500);
    throw new Error(`${operation} failed with exit code ${result.code}: ${detail}`);
  }
}

if (import.meta.main) {
  const image = Deno.args[0];
  if (Deno.args.length !== 1 || image === undefined || image.trim().length === 0) {
    console.error('Usage: deno task container:verify -- <image>');
    Deno.exit(2);
  }
  await verifyContainerImage(image);
}
