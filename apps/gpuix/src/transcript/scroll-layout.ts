/** Reuse settled geometry and the existing frame scheduler in this viewport. Geometry reuse
 * always rebuilds prepaint/paint, preserving selection and hit testing. */
export const TRANSCRIPT_SCROLL_LAYOUT = process.env.KYBERN_TRANSCRIPT_LAYOUT !== '0' ? {
  cacheLayout: true,
  // The list's cached-island bounds replay can hide the rail after a large
  // programmatic jump. Keep fresh prepaint/bounds with row geometry reuse;
  // retain the island path only as an explicit measurement control.
  ...(process.env.KYBERN_SCROLL_ISLANDS === '1' ? { cache: 'fill' as const } : {}),
} : {}
