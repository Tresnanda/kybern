// Projects the runtime theme tokens (color math from a seed), density,
// typography, and chat-width variables onto <html>.
// Kybern keeps a single default pack per variant.

import { isTauri, platform } from "@/lib/tauri"

import { getDensityCssVariables } from "./appDensity"
import { getAppTypographyScale } from "./appTypography"
import { getChatWidthCssVariables } from "./chatWidth"
import {
  DEFAULT_THEME_STATE,
  buildThemeCssVariables,
  resolveThemeVariant,
  type ThemeMode,
  type ThemeVariant,
} from "./theme/theme.logic"

const TYPOGRAPHY_VARS = (scale: ReturnType<typeof getAppTypographyScale>): Record<string, string> => ({
  "--app-font-size-ui": `${scale.uiPx}px`,
  "--app-font-size-ui-lg": `${scale.uiLgPx}px`,
  "--app-font-size-ui-sm": `${scale.uiSmPx}px`,
  "--app-font-size-ui-xs": `${scale.uiXsPx}px`,
  "--app-font-size-ui-2xs": `${scale.ui2XsPx}px`,
  "--app-font-size-ui-meta": `${scale.uiMetaPx}px`,
  "--app-font-size-ui-timestamp": `${scale.uiTimestampPx}px`,
  "--app-font-size-chat": `${scale.chatPx}px`,
  "--app-font-size-chat-code": `${scale.chatCodePx}px`,
  "--app-font-size-chat-meta": `${scale.chatMetaPx}px`,
  "--app-font-size-chat-tiny": `${scale.chatTinyPx}px`,
})

export function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function currentVariant(mode: ThemeMode): ThemeVariant {
  return resolveThemeVariant(mode, systemDark())
}

export function applyAppearance(mode: ThemeMode, opts: { suppressTransitions?: boolean } = {}): ThemeVariant {
  const root = document.documentElement
  if (opts.suppressTransitions) root.classList.add("no-transitions")

  const variant = currentVariant(mode)
  const pack = { codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }
  const mac = platform() === "macos"
  const build = buildThemeCssVariables(pack, variant, { electron: isTauri(), isMac: mac, systemUiFont: true })

  root.classList.toggle("dark", variant === "dark")
  root.setAttribute("data-code-theme-id", pack.codeThemeId)
  root.setAttribute("data-theme-mode", mode)
  root.setAttribute("data-theme-variant", variant)
  root.setAttribute("data-window-material", build.material)
  root.style.colorScheme = variant

  const vars: Record<string, string> = {
    ...build.variables,
    "--app-opaque-content-surface": build.variables["--color-background-surface"],
    ...getDensityCssVariables("comfortable"),
    ...TYPOGRAPHY_VARS(getAppTypographyScale()),
    ...getChatWidthCssVariables("standard"),
  }
  for (const [name, value] of Object.entries(vars)) {
    if (value.trim().length === 0) root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }

  if (opts.suppressTransitions) {
    void root.offsetHeight
    requestAnimationFrame(() => root.classList.remove("no-transitions"))
  }
  return variant
}
