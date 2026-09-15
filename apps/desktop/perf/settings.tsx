/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import App from "../src/App"
import { ThemeProvider } from "../src/components/theme-provider"
import { TooltipProvider } from "../src/components/kit/tooltip"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { settingsFixture } from "./settings-rpc"
import "../src/index.css"
declare const __COLLAB_THEME__: "dark" | "light"
declare const __COLLAB_VIEW__: string
declare const __COLLAB_STRESS__: string
declare const __UPDATE_REDUCED_MOTION__: boolean
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function report(value: unknown) { (window as any).webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value)) }
const checks: Record<string, boolean> = {}
function check(name: string, value: unknown) { checks[name] = !!value; if (!value) throw new Error(name) }
const visible = (node: HTMLElement) => !node.closest('[inert], [aria-hidden="true"]')
const button = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('button,[role="menuitemradio"]')).find(node => visible(node) && (node.textContent?.trim() === label || node.getAttribute("aria-label") === label))!
async function click(label: string) { const node = button(label); if (!node) throw new Error(`Missing ${label}`); node.click(); await sleep(320) }
function write(input: HTMLInputElement, value: string) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })) }
async function run() {
  if (__UPDATE_REDUCED_MOTION__) {
    const original = window.matchMedia.bind(window)
    window.matchMedia = (query) => query.includes('prefers-reduced-motion') ? { ...original(query), matches: true, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, onchange: null } : original(query)
    // Emulate the preference using the shipped reduced-motion declarations.
    const apply = (rules: CSSRuleList) => { for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion: reduce')) rule.media.mediaText = 'all'
      if ('cssRules' in rule) apply((rule as CSSGroupingRule).cssRules)
    } }
    for (const sheet of Array.from(document.styleSheets)) apply(sheet.cssRules)
  }
  useEnvironments.setState({ selectedId: "local", switching: false, profiles: [{ id: "local", name: "This Mac", url: null, environment_id: "fixture", hostname: "Local", local: true }] })
  useStore.getState().set({ connection: { state: "open" }, settingsOpen: false, projects: {}, threads: {}, splitView: null, rightOpen: false,
    settings: { default_provider: "codex", default_permission_mode: "supervised", worktrees_default: true, generate_titles: true, providers: {}, notifications: true, auto_update_harnesses: false, auto_update_daemon: false, background: { session_idle_minutes: 15, max_idle_sessions: 3, terminal_idle_minutes: 30, daemon_idle_exit_minutes: 0, save_power_on_battery: true }, access: { tailscale: false } },
    providers: [{ kind: "codex", display_name: "Codex", available: true, instances: ["default"], models: [], supported_permission_modes: ["supervised"], supports_fork: true, supports_model_switch: true }],
  })
  flushSync(() => createRoot(document.getElementById("root")!).render(<ThemeProvider defaultTheme={__COLLAB_THEME__} storageKey="fixture.theme"><TooltipProvider><App /></TooltipProvider></ThemeProvider>))
  await sleep(500)
  if (__COLLAB_STRESS__ === 'rtl') document.documentElement.dir = 'rtl'
  if (__COLLAB_STRESS__ === 'large-text') { const style = document.createElement('style'); style.textContent = '.settings-screen { --app-font-size-ui: 16px; }'; document.head.append(style) }
  const workspace = document.querySelector('.settings-workspace')
  const trigger = button('Settings')
  const openSettings = async () => {
    if (trigger) { trigger.focus(); trigger.click() }
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
    await sleep(320)
  }
  await openSettings()
  check('dedicated screen', document.querySelector('.settings-screen') && !document.querySelector('[role="dialog"]'))
  check('workspace preserved and inert', document.querySelector('.settings-workspace') === workspace && workspace?.hasAttribute('inert'))
  if (__UPDATE_REDUCED_MOTION__) check('reduced motion has no section animation', getComputedStyle(document.querySelector('.settings-section-content')!).animationName === 'none')
  check('heading focused', document.activeElement === document.querySelector('.settings-page-heading h1'))
  if (__COLLAB_VIEW__ === 'general') return report({ pass: true, checks })
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  write(input, 'glass'); await sleep(100)
  check('search finds appearance', button('Appearance') && !button('General'))
  await click('Appearance')
  check('theme cards', document.querySelectorAll('.settings-theme-choice').length === 3)
  if (__COLLAB_VIEW__ === 'appearance') return report({ pass: true, checks })
  if (!__UPDATE_REDUCED_MOTION__) {
    button('General').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); await sleep(30)
    for (const animation of document.querySelector('.settings-section-content')!.getAnimations()) animation.playbackRate = 0.1
    await sleep(80)
    button('Appearance').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); await sleep(300)
    check('slow section transition can be replaced', document.querySelector('.settings-page-heading h1')?.textContent === 'Appearance' && getComputedStyle(document.querySelector('.settings-section-content')!).opacity === '1')
  }
  await click('Agent providers'); check('agents remain available', !!document.querySelector('.settings-page')?.textContent?.includes('Update harnesses automatically'))
  await click('Notifications')
  check('notifications have a dedicated destination', !!document.querySelector('[aria-label="Show agent notifications"]'))
  await click('Background activity')
  check('background has a dedicated destination', !!document.querySelector('.settings-page')?.textContent?.includes('Save power on battery'))
  check('navigation is categorized', document.querySelectorAll('.settings-nav-category').length === 3)
  await click('General')
  const worktree = document.querySelector<HTMLElement>('[role="switch"][aria-label="Use a worktree for new threads"]')!
  worktree.click(); await sleep(100)
  check('settings still save', useStore.getState().settings?.worktrees_default === false)
  await click('Appearance')
  await click('Dark'); check('theme changes', document.documentElement.classList.contains('dark')); if (__COLLAB_THEME__ === 'light') await click('Light')
  await click('Usage'); check('usage totals', document.querySelector('.usage-stat dd')?.textContent === '$17.64')
  if (__COLLAB_VIEW__ === 'usage') { check(`usage fits viewport (${document.querySelector('.settings-scroll')!.scrollWidth}/${document.querySelector('.settings-scroll')!.clientWidth})`, document.querySelector('.settings-scroll')!.scrollWidth <= document.querySelector('.settings-scroll')!.clientWidth); return report({ pass: true, checks }) }
  settingsFixture.delay = 600
  button('Model').click(); await sleep(40); settingsFixture.delay = 20; button('Day').click(); await sleep(750)
  check('latest filter wins', document.querySelector('.usage-table th')?.textContent === 'Day (UTC)' && !document.querySelector('.usage-table')?.textContent?.includes('claude-sonnet'))
  settingsFixture.delay = 20
  settingsFixture.fail = true; await click('Refresh')
  check('error has recovery', button('Try again') && document.querySelector('[role="alert"]'))
  settingsFixture.fail = false; await click('Try again')
  check('retry recovers', !!document.querySelector('.usage-summary'))
  await click('Usage period')
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(250)
  check('menu Escape keeps settings open', useStore.getState().settingsOpen && !document.querySelector('[role="menu"]'))
  await click('Usage period'); await click('Last 7 days')
  check('date filter sent', settingsFixture.calls.at(-1).since && document.querySelectorAll('.usage-chart-day').length === 7)
  settingsFixture.empty = true; await click('Refresh')
  check('empty is explicit', document.body.textContent?.includes('No usage in this period') && button('Show all time'))
  settingsFixture.empty = false; await click('Show all time')
  check('all time clears lower bound', settingsFixture.calls.at(-1).since === undefined)
  if (!__UPDATE_REDUCED_MOTION__) {
    button('Back to workspace').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    button('Back to workspace').click(); await sleep(30)
    useStore.getState().set({ settingsOpen: true }); await sleep(300)
    check('screen exit can be reversed', !!document.querySelector('.settings-screen') && workspace?.hasAttribute('inert'))
  }
  await click('Back to workspace')
  check('return preserved workspace', !document.querySelector('.settings-screen') && document.querySelector('.settings-workspace') === workspace && !workspace?.hasAttribute('inert'))
  check('return restores focus', !trigger || document.activeElement === trigger)
  await openSettings(); document.querySelector('.settings-screen')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300)
  check('escape returns', !useStore.getState().settingsOpen)
  check('no horizontal overflow', document.documentElement.scrollWidth <= innerWidth)
  report({ pass: true, checks })
}
run().catch(error => report({ pass: false, checks, error: String(error) }))
