import type { VisualTheme } from "../../../../packages/kybern-client/src/visuals"

const THEME_VARIABLES = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "border", "input", "ring", "primary", "primary-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground", "warning", "warning-foreground", "success", "success-foreground", "info", "info-foreground", "radius"]
/** The page paints this color, so it must be the surface the transcript or panel paints. */
function surfaceColor(): string | null {
  const probe = document.createElement("i")
  probe.style.cssText = "display:none;background-color:var(--color-background-surface)"
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  return color && color !== "rgba(0, 0, 0, 0)" ? color : null
}
export function currentTheme(): VisualTheme {
  const root = document.documentElement, computed = getComputedStyle(root)
  const variables: Record<string, string> = {}
  for (const name of THEME_VARIABLES) { const value = computed.getPropertyValue(`--${name}`).trim(); if (value) variables[`--${name}`] = value }
  variables["--font-sans"] = computed.getPropertyValue("--font-ui-family").trim() || "system-ui, sans-serif"
  variables["--font-mono"] = computed.getPropertyValue("--font-mono-family").trim() || "Menlo, monospace"
  const dark = root.classList.contains("dark")
  const surface = surfaceColor()
  if (surface) variables["--background"] = surface
  // Accent here is the brand color rather than Kybern's neutral hover fill.
  variables["--accent"] = computed.getPropertyValue("--color-text-accent").trim() || variables["--primary"]
  variables["--chart-1"] = variables["--accent"]
  const colors = dark ? ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"] : ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"]
  colors.forEach((color, i) => variables[`--chart-${i + 2}`] = color)
  variables["--code-background"] = computed.getPropertyValue("--color-background-code").trim() || variables["--card"]
  variables["--code-foreground"] = variables["--foreground"]
  return { appearance: dark ? "dark" : "light", variables }
}

/** The inline button that opened the panel, so closing the panel can return focus to it. */
let previewOrigin: WeakRef<HTMLElement> | null = null
export function setPreviewOrigin(element: HTMLElement) { previewOrigin = new WeakRef(element) }
export function restorePreviewFocus(): boolean {
  const origin = previewOrigin?.deref()
  previewOrigin = null
  if (!origin?.isConnected || origin.closest("[inert]")) return false
  origin.focus({ preventScroll: true })
  return true
}

