/** Stable repository identity used by build and contract tooling. */
export const SERVICE_NAME = 'ca-arcgis-api' as const;

/** Process composition remains unavailable while the offline source boundary is built. */
export function main(): never {
  throw new Error('The CA ArcGIS API runtime composition is not implemented.');
}

if (import.meta.main) {
  main();
}
