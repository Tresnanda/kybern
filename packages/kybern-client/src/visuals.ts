/** Small, pure validators shared by inline frames and their rendering fixtures. */
export interface VisualTheme { appearance: "dark" | "light"; variables: Record<string, string> }
import type { HtmlVisual, VisualHeight } from "./types.ts";
export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 2000;
/** The reply column (46rem) at the default chat width; picks the measured height when a client cannot know its width. */
export const VISUAL_COLUMN_WIDTH = 736;
const MAX_MEASURED_HEIGHTS = 24;
export function clampVisualHeight(height: number): number {
  return Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(height)));
}
/** A page-reported content height, bounded by `cap` (the inline frame limit by default). */
export function visualHeight(value: unknown, cap: number = VISUAL_MAX_HEIGHT): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(VISUAL_MIN_HEIGHT, Math.min(cap, Math.ceil(value))) : null;
}
/** Validated, width-sorted measurements; undefined when the list is absent or malformed. */
export function readVisualHeights(value: unknown): VisualHeight[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) return undefined;
  const heights: VisualHeight[] = [];
  for (const entry of value) {
    const width = entry?.width, height = entry?.height;
    if (!Number.isInteger(width) || width < 1 || width > 10_000 || !Number.isInteger(height) || height < 0) return undefined;
    heights.push({ width, height: clampVisualHeight(height) });
  }
  return heights.sort((a, b) => a.width - b.width);
}
/** Taller of the heights measured at the nearest widths on each side: a breakpoint between two widths can make the page as tall as either. */
export function visualMeasuredHeight(heights: readonly VisualHeight[], width: number): number {
  const above = heights.findIndex(entry => entry.width >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]!.width === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]!.height, heights[high]!.height);
}
/**
 * The box a visual reserves at a frame width. The page's own posted height wins; else the
 * daemon's measurement for that width. The agent's height caps it only when it is below the
 * page's height at the column width (the agent asked for a scrolling frame) or when the page
 * was never measured.
 */
export function visualFrameHeight(visual: Pick<HtmlVisual, "height" | "heights">, width: number, contentHeight?: number): number {
  const heights = visual.heights;
  if (!heights || heights.length === 0) return clampVisualHeight(Math.min(visual.height, contentHeight ?? visual.height));
  const cap = visualMeasuredHeight(heights, VISUAL_COLUMN_WIDTH) > visual.height ? visual.height : VISUAL_MAX_HEIGHT;
  return clampVisualHeight(Math.min(cap, contentHeight ?? visualMeasuredHeight(heights, width)));
}
export function visualLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function visualFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").replace(/\s+/g," ").trim().slice(0,120) || "Visual"}.html`;
}
export function visualThemeFragment(theme: VisualTheme): string { return `#kybern-theme=${encodeURIComponent(JSON.stringify(theme))}`; }
