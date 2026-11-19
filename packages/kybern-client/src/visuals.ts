/** Small, pure validators shared by inline frames and their rendering fixtures. */
export interface VisualTheme { appearance: "dark" | "light"; variables: Record<string, string> }
import type { HtmlVisual, VisualHeight } from "./types.ts";
export const VISUAL_MIN_HEIGHT = 80;
/** Inline frames fit their page up to this height; it only stops a page that grows with its frame (`vh` units are refused at publish). */
export const VISUAL_MAX_HEIGHT = 20_000;
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
 * The box a visual reserves at a frame width: the frame fits the page. The page's own posted height wins; else the
 * daemon's measurement for that width; else the agent's first-paint height.
 */
export function visualFrameHeight(visual: Pick<HtmlVisual, "height" | "heights">, width: number, contentHeight?: number): number {
  if (contentHeight !== undefined) return clampVisualHeight(contentHeight);
  const heights = visual.heights;
  return clampVisualHeight(heights && heights.length > 0 ? visualMeasuredHeight(heights, width) : visual.height);
}
export function visualLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function visualFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").replace(/\s+/g," ").trim().slice(0,120) || "Visual"}.html`;
}
export function visualThemeFragment(theme: VisualTheme): string { return `#kybern-theme=${encodeURIComponent(JSON.stringify(theme))}`; }
