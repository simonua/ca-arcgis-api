import {
  CONTAINER_SECURITY_CHECK_ARGUMENT,
  inspectContainerSecurity,
} from './runtime/container-security-check.ts';

/** Stable repository identity used by build and contract tooling. */
export const SERVICE_NAME = 'ca-arcgis-api' as const;

/** Process startup remains unavailable until reviewed static configuration is committed. */
export function main(): never {
  throw new Error('Runtime startup requires reviewed static configuration artifacts.');
}

if (import.meta.main) {
  if (Deno.args.length === 1 && Deno.args[0] === CONTAINER_SECURITY_CHECK_ARGUMENT) {
    const report = await inspectContainerSecurity();
    console.log(JSON.stringify(report));
    Deno.exit(report.ok ? 0 : 1);
  }
  main();
}
