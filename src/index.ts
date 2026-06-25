/** Stable repository identity used by build and contract tooling. */
export const SERVICE_NAME = 'ca-arcgis-api' as const;

/**
 * Process composition remains intentionally unavailable until the proposal's
 * implementation gates are approved.
 */
export function main(): never {
  throw new Error('The CA ArcGIS API service is not implemented.');
}

if (import.meta.main) {
  main();
}
