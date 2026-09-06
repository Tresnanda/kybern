import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@fontsource-variable/jetbrains-mono/index.css"
import "@fontsource/cal-sans/index.css"
import "./index.css"
import App from "./App"
import { ErrorBoundary } from "@/components/kybern/ErrorBoundary"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/kit/tooltip"
import { isTauri, platform } from "@/lib/tauri"
import { startAppUpdateChecks } from "@/lib/appUpdate"
import { boot } from "@/state/rpc"
import { installRuntimeErrorReporting } from "@/lib/runtimeErrors"
import { showRuntimeError } from "@/components/kybern/runtimeErrorNotice"

// Dev only: `VITE_KYBERN_THEME=light pnpm tauri dev` boots the window in a fixed
// appearance so light and dark can be screenshotted without touching settings.
// `system` puts the stored preference back.
const forcedTheme = import.meta.env.VITE_KYBERN_THEME
if (import.meta.env.DEV && (forcedTheme === "light" || forcedTheme === "dark" || forcedTheme === "system")) {
  localStorage.setItem("kybern.theme", forcedTheme)
}

// The kit stylesheet keys desktop-only rules (traffic-light gutter, corner
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

const stopErrorReporting = installRuntimeErrorReporting(window, showRuntimeError)
if (import.meta.hot) import.meta.hot.dispose(stopErrorReporting)

void boot()
startAppUpdateChecks()

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
