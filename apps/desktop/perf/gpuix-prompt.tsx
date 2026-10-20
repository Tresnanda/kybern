// Kybern GPUIX invitation card over the production store and views. The shell
// is never reached: states are set directly. Query: `?theme=light|dark`.
// Playwright (or the native harness) drives `window.__gpuixFixture`.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"

import { ThemeProviderContext } from "../src/components/theme-context"
import { SidebarProvider } from "../src/components/kit/sidebar"
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
} from "../src/lib/kit/theme/theme.logic"
import { useAppUpdate } from "../src/lib/appUpdate"
import { useGpuix } from "../src/lib/gpuix"
import { GpuixPromptSurface } from "../src/views/GpuixPrompt"
import { AppUpdateSurface } from "../src/views/AppUpdate"
import "../src/index.css"

const params = new URLSearchParams(location.search)
const variant = params.get("theme") === "light" ? "light" : "dark"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const report = (value: Record<string, unknown>) => {
  const target = window as unknown as {
    webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } }
  }
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
}

const root = document.documentElement
const built = buildThemeCssVariables(
  {
    codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant],
    theme: DEFAULT_THEME_STATE.chromeThemes[variant],
  },
  variant,
  { electron: true, isMac: true, systemUiFont: true }
)
root.classList.toggle("dark", variant === "dark")
root.dataset.themeVariant = variant
root.dataset.themeMode = variant
root.dataset.runtime = "electron"
root.dataset.platform = "macos"
root.dataset.windowMaterial = "opaque"
root.style.colorScheme = variant
for (const [name, value] of Object.entries(built.variables)) root.style.setProperty(name, value)
root.style.setProperty("--app-opaque-content-surface", built.variables["--color-background-surface"]!)

const manual =
  "curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh | sh"
const states = {
  idle: { phase: "idle", step: null, progress: null, error: null },
  installing: { phase: "installing", step: "downloading", progress: 0.42, error: null },
  verifying: { phase: "installing", step: "verifying", progress: null, error: null },
  done: { phase: "done", step: null, progress: null, error: null },
  error: {
    phase: "error",
    step: null,
    progress: null,
    error: `The Kybern GPUIX download failed. Check your connection and try again. To install it yourself, run this in Terminal: ${manual}`,
  },
} as const

useGpuix.setState({ supported: true, eligible: true, dismissed: false, ...states.idle })
useAppUpdate.setState({
  phase: "current",
  appVersion: "0.10.0",
  checkedAt: Date.now(),
  announcementOpen: false,
  detailsOpen: false,
})

const visible = (element: Element | null) =>
  element instanceof HTMLElement &&
  element.getClientRects().length > 0 &&
  Number(getComputedStyle(element).opacity) > 0.02
const card = () => document.querySelector('[data-testid="gpuix-prompt"]')

const control = {
  set: (name: keyof typeof states) => useGpuix.setState({ dismissed: false, ...states[name] }),
  hide: () => useGpuix.setState({ dismissed: true }),
  announce: (open: boolean) => useAppUpdate.setState({ announcementOpen: open }),
}
;(window as unknown as { __gpuixFixture: typeof control }).__gpuixFixture = control

flushSync(() =>
  createRoot(document.getElementById("root")!).render(
    <ThemeProviderContext
      value={{ theme: variant, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}
    >
      <>
        <SidebarProvider className="h-dvh min-h-0 bg-[var(--app-shell-background)] text-foreground">
          <aside className="hidden w-64 shrink-0 flex-col border-e border-[color:var(--app-surface-divider)] bg-[var(--sidebar-background)] p-2 md:flex">
            <div className="h-[46px] drag-region" />
            <div className="px-2 text-[17px] font-medium">kybern</div>
          </aside>
          <main className="relative flex min-w-0 flex-1 flex-col bg-[var(--color-background-surface)] p-8">
            <p className="mx-auto mt-12 w-full max-w-xl text-sm text-muted-foreground">
              Plan the next release.
            </p>
          </main>
        </SidebarProvider>
        <AppUpdateSurface />
        <GpuixPromptSurface />
      </>
    </ThemeProviderContext>
  )
)

// Self-check for the native harness: the card queues behind the update
// announcement, then appears, and closes for good on "Not now".
void (async () => {
  try {
    await sleep(500)
    if (!visible(card())) throw new Error("card appears when nothing else is open")
    control.announce(true)
    await sleep(500)
    if (card()) throw new Error("card yields to the update announcement")
    control.announce(false)
    await sleep(500)
    if (!visible(card())) throw new Error("card returns after the announcement")
    ;(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Not now") as HTMLElement).click()
    await sleep(500)
    if (card()) throw new Error("Not now closes the card")
    control.set("idle")
    report({ fixture: "gpuix-prompt", pass: true })
  } catch (error) {
    report({ fixture: "gpuix-prompt", pass: false, error: String(error) })
  }
})()
