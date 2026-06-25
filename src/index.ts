/** Stable repository identity used by build and contract tooling. */
export const SERVICE_NAME = 'ca-arcgis-api' as const;

/** Process startup remains unavailable until reviewed static configuration is committed. */
export function main(): never {
  throw new Error('Runtime startup requires reviewed static configuration artifacts.');
}

if (import.meta.main) {
  main();
}
