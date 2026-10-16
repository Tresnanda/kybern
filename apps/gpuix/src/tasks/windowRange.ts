/** Fill the viewport in pixels, even when a splice changes logical indexes but
 * the native list's last visible-range notification hasn't changed yet. */
export function taskWindowRange(heights: number[], anchor: number, viewport: number, overscan: number) {
  const first = Math.max(0, Math.min(heights.length - 1, anchor))
  let end = first, remaining = Math.max(0, viewport)
  while (end < heights.length && remaining >= 0) remaining -= Math.max(1, heights[end++] ?? 40)
  return {start: Math.max(0, first - overscan), end: Math.min(heights.length, end + overscan)}
}
