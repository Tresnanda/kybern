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
  document.documentElement.dir = import.meta.env.VITE_PERF_RTL ? "rtl" : "ltr"
  document.documentElement.dataset.windowMaterial = "opaque"
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true })
  for (const [key, value] of Object.entries(built.variables)) document.documentElement.style.setProperty(key, value)
  document.documentElement.style.setProperty("--app-font-size-ui", `${12 * Number(import.meta.env.VITE_PERF_TEXT_SCALE || 1)}px`)
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
async function until(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 4000
  while (!predicate() && performance.now() < deadline) await sleep(20)
  check(predicate(), message)
}
async function choose(label: string, option: string) {
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
  await until(() => document.querySelector('[role="menuitemradio"]'), "Profile menu opens")
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === option)
  check(item, `Missing option: ${option}`)
  item!.click()
  await sleep(300)
}
async function openOverrides() {
  document.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click()
  await until(() => document.querySelector('[aria-label="Choose project"]'), "Project controls open")
  await sleep(250)
}
async function run() {
  useStore.getState().set({ projects: {
    fixture: { id: "fixture", name: "Kybern", path: "/projects/kybern", is_git: true, created_at: "", updated_at: "" },
    other: { id: "other", name: "Application infrastructure and international collaboration", path: "/projects/other", is_git: true, created_at: "", updated_at: "" },
  } })
  render()
  check(!document.querySelector('[aria-label="Project OMP profile source"]'), "Advanced controls should start collapsed")
  check(document.querySelector('[aria-label="Default OMP profile source"]')?.textContent?.includes("Use environment"), "Inheritance is explicit")
  await choose("Default OMP profile source", "Named profile")
  check(document.activeElement?.getAttribute("aria-label") === "Default OMP profile", "Choosing a named profile focuses its name")
  await edit("Default OMP profile", "personal")
  check(settings.providers.omp!.env.OMP_PROFILE === "personal", "Default profile was not saved")
  await openOverrides()
  await choose("Project OMP profile source", "Named profile")
  await edit("Project OMP profile", "work")
  check(settings.providers.omp!.project_profiles?.["/projects/kybern"] === "work", "Project override was not saved")
  await choose("Project OMP profile source", "OMP default")
  check(settings.providers.omp!.project_profiles?.["/projects/kybern"] === "default", "Explicit default was lost")
  await choose("Project OMP profile source", "Use default above")
  check(!Object.hasOwn(settings.providers.omp!.project_profiles!, "/projects/kybern"), "Inheritance did not remove the override")
  const input = document.querySelector<HTMLInputElement>('[aria-label="Default OMP profile"]')!
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "discard-me")
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await sleep(20)
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await sleep(30)
  check(settings.providers.omp!.env.OMP_PROFILE === "personal", "Escape saved an unwanted profile")
  check(document.activeElement?.getAttribute("aria-label") === "Default OMP profile source", "Escape returns focus to the profile choice")
  check(settings.providers.omp!.env.KEEP_ME === "yes" && settings.providers.omp!.binary === "/custom/omp" && settings.providers.omp!.model === "local/model", "Profile edit replaced other provider settings")
  settings.providers.omp!.env.OMP_PROFILE = ""
  settings.providers.omp!.project_profiles!["/projects/kybern"] = ""
  render()
  check(document.querySelector('[aria-label="Default OMP profile source"]')?.textContent?.includes("OMP default"), "Explicit empty profile was incorrectly shown as inherited")
  check(document.querySelector('[aria-label="Project OMP profile source"]')?.textContent?.includes("OMP default"), "Explicit empty project profile was incorrectly shown as inherited")
  variant = import.meta.env.VITE_PERF_THEME === "light" ? "light" : "dark"
  render()
  await choose("Project OMP profile source", "Named profile")
  await edit("Project OMP profile", "work")
  await choose("Choose project", "Application infrastructure and international collaboration")
  check(document.querySelector('[aria-label="Project OMP profile source"]')?.textContent?.includes("Use default above"), "Project selection leaked another project's profile")
  await choose("Choose project", "Kybern")
  check(document.querySelector<HTMLInputElement>('[aria-label="Project OMP profile"]')?.value === "work", "Project selection lost its saved profile")
  const trigger = document.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!
  const panel = document.querySelector<HTMLElement>('[data-slot="collapsible-panel"]')!
  const slow = document.createElement("style")
  slow.textContent = "[data-slot=collapsible-panel] { transition-duration: 2.2s !important }"
  document.head.append(slow)
  const expandedHeight = panel.getBoundingClientRect().height
  trigger.click()
  await sleep(200)
  const intermediateHeight = panel.getBoundingClientRect().height
  check(intermediateHeight > 0 && intermediateHeight < expandedHeight, "Disclosure does not transition through a partial height")
  trigger.click()
  await sleep(2300)
  slow.remove()
  check(document.querySelector<HTMLInputElement>('[aria-label="Project OMP profile"]')?.value === "work", "Reversing a disclosure lost its state")
  trigger.click()
  await until(() => !document.querySelector('[aria-label="Project OMP profile source"]'), "Closed disclosure unmounts its controls")
  await openOverrides()
  const failures: string[] = []
  for (const field of document.querySelectorAll('input, [data-omp-profiles] button')) {
    const rect = field.getBoundingClientRect()
    if (rect.left < -1 || rect.right > innerWidth + 1) failures.push("Profile control overflows the window")
  }
  if (variant === "dark") {
    const picker = document.querySelector<HTMLElement>('[data-slot="menu-trigger"]')!
    check(getComputedStyle(picker).color !== "rgb(0, 0, 0)", "Profile picker is unreadable in the dark theme")
  }
  const native = (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
  native.postMessage(JSON.stringify({ pass: failures.length === 0, failures, saved: true, inherited: true, cancellation: true, projectSelection: true, disclosureUnmount: true, slowMotionReversal: true, theme: variant }))
}
run().catch(error => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
