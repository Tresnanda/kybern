/** Small, pure validators shared by inline frames and their rendering fixtures. */
export interface VisualTheme { appearance: "dark" | "light"; variables: Record<string, string> }
export function visualHeight(value: unknown, cap: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(80, Math.min(2000, cap, Math.ceil(value))) : null;
}
export function visualLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function visualFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").replace(/\s+/g," ").trim().slice(0,120) || "Visual"}.html`;
}
export function visualThemeFragment(theme: VisualTheme): string { return `#kybern-theme=${encodeURIComponent(JSON.stringify(theme))}`; }
