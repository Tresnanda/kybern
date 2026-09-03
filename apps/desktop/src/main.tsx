import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@fontsource-variable/jetbrains-mono/index.css"
import "@fontsource/cal-sans/index.css"
import "./index.css"
import App from "./App"
import { ErrorBoundary } from "@/components/kybern/ErrorBoundary"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/synara/tooltip"
import { isTauri, platform } from "@/lib/tauri"
import { boot } from "@/state/rpc"

// Dev only: `VITE_KYBERN_THEME=light pnpm tauri dev` boots the window in a fixed
// appearance so light and dark can be screenshotted without touching settings.
// `system` puts the stored preference back.
const forcedTheme = import.meta.env.VITE_KYBERN_THEME
if (import.meta.env.DEV && (forcedTheme === "light" || forcedTheme === "dark" || forcedTheme === "system")) {
  localStorage.setItem("kybern.theme", forcedTheme)
}

// Synara's stylesheet keys desktop-only rules (traffic-light gutter, corner
// smoothing) off this attribute; the Tauri shell wants the same treatment.
if (isTauri()) {
  document.documentElement.dataset.runtime = "electron"
  document.documentElement.dataset.platform = platform()
}

// Right-click navigation is meaningless in a shell; keep the webview inside the app.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null
  if (t && !t.closest(".selectable, input, textarea")) e.preventDefault()
})

void boot()

// Uncaught errors outside React land on screen too; a blank webview is otherwise undebuggable.
function reportFatal(message: string) {
  const el = document.createElement("pre")
  el.style.cssText = "position:fixed;inset:auto 8px 8px 8px;z-index:9999;max-height:40vh;overflow:auto;padding:8px 10px;border-radius:8px;background:#7f1d1d;color:#fff;font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;user-select:text"
  el.textContent = message
  document.body.appendChild(el)
}
window.addEventListener("error", (e) => reportFatal(`${e.message}\n${e.error?.stack ?? ""}`))
window.addEventListener("unhandledrejection", (e) => reportFatal(`Unhandled rejection: ${e.reason?.stack ?? String(e.reason)}`))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="the app">
      <ThemeProvider defaultTheme="system" storageKey="kybern.theme">
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
