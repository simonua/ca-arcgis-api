const DENO_BUILDER =
  'denoland/deno:2.9.0@sha256:690c343f50ee4ceaae179f480fb110b3146b9428fbf676cac9fe21c62438e229';
const DISTROLESS_RUNTIME =
  'gcr.io/distroless/cc-debian12:nonroot@sha256:949e6cfda7141a19179964a7eb60d83c9eb1366c6b2cd36a6fd6f28c6baea8b9';

Deno.test('Dockerfile pins a rootless shell-free runtime contract', async () => {
  const dockerfile = await Deno.readTextFile('Dockerfile');

  assertEquals(count(dockerfile, /^FROM /gm), 2);
  assertIncludes(dockerfile, `FROM ${DENO_BUILDER} AS build`);
  assertIncludes(dockerfile, `FROM ${DISTROLESS_RUNTIME} AS runtime`);
  assertIncludes(dockerfile, 'RUN chown deno:deno /workspace');
  assertIncludes(dockerfile, 'USER deno:deno');
  assertIncludes(dockerfile, 'RUN deno task verify');
  assertIncludes(dockerfile, 'RUN deno task compile:container');
  assertIncludes(dockerfile, '--chmod=0555');
  assertIncludes(dockerfile, 'USER 65532:65532');
  assertIncludes(dockerfile, 'ENTRYPOINT ["/ca-arcgis-api"]');
  assertIncludes(dockerfile, 'STOPSIGNAL SIGTERM');
  assertEquals(/^HEALTHCHECK /m.test(dockerfile), false);
  assertEquals(/^VOLUME /m.test(dockerfile), false);
  assertEquals(/^ADD /m.test(dockerfile), false);
  assertEquals(/^ENTRYPOINT .*sh/m.test(dockerfile), false);
});

Deno.test('Docker build context is an explicit allowlist', async () => {
  const dockerignore = await Deno.readTextFile('.dockerignore');
  const lines = dockerignore.split('\n').filter((line) => line.length > 0);

  assertEquals(lines[0], '*');
  for (
    const required of [
      '!Dockerfile',
      '!.github/workflows/ci.yml',
      '!deno.json',
      '!deno.lock',
      '!src/**',
      '!tests/**',
      '!tools/**',
    ]
  ) {
    assertEquals(lines.includes(required), true);
  }
});

Deno.test('container compile task embeds the reviewed permission boundary', async () => {
  const parsed: unknown = JSON.parse(await Deno.readTextFile('deno.json'));
  if (!isRecord(parsed) || !isRecord(parsed.tasks)) {
    throw new Error('deno.json does not contain a task map.');
  }
  const command = parsed.tasks['compile:container'];
  if (typeof command !== 'string') {
    throw new Error('compile:container task is missing.');
  }

  for (
    const expected of [
      'deno compile --no-prompt',
      '--target=x86_64-unknown-linux-gnu',
      '--allow-env=ARCGIS_EMERGENCY_DISABLED,CIRCUIT_FAILURE_THRESHOLD,CIRCUIT_INITIAL_BREAK_SECONDS,HTTP_PORT,MAX_BACKOFF_SECONDS,POLL_ENABLED,POLL_INTERVAL_SECONDS,POLL_TIMEOUT_SECONDS',
      '--allow-net=0.0.0.0:8080,services8.arcgis.com:443',
      '--deny-read',
      '--deny-write',
      '--deny-run',
      '--deny-ffi',
      '--deny-sys',
    ]
  ) {
    assertIncludes(command, expected);
  }
  assertEquals(command.includes('--allow-all'), false);
  assertEquals(command.includes('--allow-read'), false);
  assertEquals(command.includes('--allow-write'), false);
  assertEquals(command.includes('--allow-run'), false);
  assertEquals(command.includes('--allow-ffi'), false);
  assertEquals(command.includes('--allow-sys'), false);
});

Deno.test('container CI builds, verifies, and scans without publishing', async () => {
  const workflow = await Deno.readTextFile('.github/workflows/ci.yml');

  for (
    const expected of [
      'run: deno task container:build',
      'run: deno task container:verify',
      'uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0',
      'image-ref: ca-arcgis-api:local',
      'scanners: vuln,secret',
      'severity: HIGH,CRITICAL',
      'ignore-unfixed: false',
      'exit-code: 1',
    ]
  ) {
    assertIncludes(workflow, expected);
  }
  assertEquals(workflow.includes('docker push'), false);
});

function count(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`Expected value to include: ${expected}`);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
