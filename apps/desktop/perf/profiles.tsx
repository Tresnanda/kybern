import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { OmpProfiles } from "../src/views/SettingsDialog"
import { useStore } from "../src/state/store"
import type { Settings } from "../src/protocol"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import "../src/index.css"

const root = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
let settings = { providers: { omp: { binary: "/custom/omp", model: "local/model", env: { KEEP_ME: "yes" } } } } as unknown as Settings
let variant: "light" | "dark" = "light"
function render() {
  document.documentElement.classList.toggle("dark", variant === "dark")
  document.documentElement.style.colorScheme = variant
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true })
  for (const [key, value] of Object.entries(built.variables)) document.documentElement.style.setProperty(key, value)
  flushSync(() => root.render(<main className="app-settings-surface mx-auto max-w-2xl p-6"><OmpProfiles settings={settings} update={async patch => { settings = { ...settings, ...patch }; render() }} /></main>))
}
async function edit(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await sleep(20)
  input.blur()
  await sleep(20)
}
async function run() {
  useStore.getState().set({ projects: { fixture: { id: "fixture", name: "Kybern", path: "/projects/kybern", is_git: true, created_at: "", updated_at: "" } } })
  render()
  await edit("Default OMP profile", "personal")
  check(settings.providers.omp!.env.OMP_PROFILE === "personal", "Default profile was not saved")
  await edit("Project OMP profile", "work")
  check(settings.providers.omp!.project_profiles?.["/projects/kybern"] === "work", "Project override was not saved")
  await edit("Project OMP profile", "default")
  check(settings.providers.omp!.project_profiles?.["/projects/kybern"] === "default", "Explicit default was lost")
  await edit("Project OMP profile", "")
  check(!Object.hasOwn(settings.providers.omp!.project_profiles!, "/projects/kybern"), "Empty profile did not restore inheritance")
  const input = document.querySelector<HTMLInputElement>('[aria-label="Default OMP profile"]')!
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "discard-me")
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await sleep(20)
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await sleep(20)
  input.blur()
  check(settings.providers.omp!.env.OMP_PROFILE === "personal", "Escape saved an unwanted profile")
  check(settings.providers.omp!.env.KEEP_ME === "yes" && settings.providers.omp!.binary === "/custom/omp" && settings.providers.omp!.model === "local/model", "Profile edit replaced other provider settings")
  settings.providers.omp!.env.OMP_PROFILE = ""
  settings.providers.omp!.project_profiles!["/projects/kybern"] = ""
  render()
  for (const field of document.querySelectorAll<HTMLInputElement>('input')) check(field.value === "default", "Explicit empty profile was incorrectly shown as inherited")
  variant = "dark"
  render()
  await edit("Project OMP profile", "work")
  // Let the kit's color transition finish before assessing the dark appearance.
  await sleep(250)
  const failures: string[] = []
  for (const field of document.querySelectorAll('input')) {
    const rect = field.getBoundingClientRect()
    if (rect.left < 0 || rect.right > innerWidth) failures.push("Profile input overflows the window")
  }
  const picker = document.querySelector<HTMLElement>('[data-slot="menu-trigger"]')!
  const color = getComputedStyle(picker).color
  check(color !== "rgb(0, 0, 0)", "Project picker is unreadable in the dark theme")
  const native = (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
  native.postMessage(JSON.stringify({ pass: failures.length === 0, failures, saved: true, inherited: true, cancellation: true }))
}
run().catch(error => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
