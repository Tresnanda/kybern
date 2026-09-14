import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { toast } from "sonner"

import { ThemeProviderContext } from "../src/components/theme-context"
import { SidebarProvider } from "../src/components/kit/sidebar"
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
} from "../src/lib/kit/theme/theme.logic"
import { fixtureInstall, useAppUpdate } from "./app-update-transport"
import "../src/index.css"

declare const __UPDATE_VIEW__: "card" | "details"
declare const __UPDATE_THEME__: "dark" | "light"
declare const __UPDATE_REDUCED_MOTION__: boolean

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const checks: Record<string, boolean> = {}
const check = (condition: unknown, label: string) => {
  checks[label] = !!condition
  if (!condition) throw new Error(label)
}
const report = (value: Record<string, unknown>) => {
  const target = window as unknown as {
    __appUpdateResults?: unknown[]
    webkit?: {
      messageHandlers?: { bench?: { postMessage: (value: string) => void } }
    }
  }
  ;(target.__appUpdateResults ??= []).push(value)
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
}
const visible = (element: Element | null): element is HTMLElement => {
  if (
    !(element instanceof HTMLElement) ||
    element.getClientRects().length === 0
  )
    return false
  const style = getComputedStyle(element)
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) > 0.02
  )
}
const byLabel = (label: string, scope: ParentNode = document) =>
  Array.from(
    scope.querySelectorAll<HTMLElement>("button,[role=button],a")
  ).find(
    (element) =>
      visible(element) &&
      (element.getAttribute("aria-label") === label ||
        element.textContent?.trim() === label)
  )
const click = async (label: string, delay = 260) => {
  const button = byLabel(label)
  if (!button) throw new Error(`Missing action: ${label}`)
  button.click()
  await sleep(delay)
  return button
}
const waitFor = async (condition: () => unknown, label: string) => {
  const deadline = performance.now() + 8000
  while (!condition() && performance.now() < deadline) await sleep(50)
  check(condition(), label)
}
const state = {
  phase: "available" as const,
  appVersion: "0.3.9",
  version: "0.4.0",
  notes: `<!-- kybern-release-title: Faster conversations, clearer collaboration -->
<!-- kybern-release-summary: A focused update for steadier streaming, shared work, and a calmer desktop. -->

## What’s new

Kybern 0.4 keeps long conversations responsive while agents work together across several threads.

- Follow delegated work from the conversation and return without losing your reading position.
- Stream long Markdown responses with stable formatting and exact final text.
- Review update details before Kybern downloads anything.

## Reliability

Update downloads now show progress and leave the release available when verification fails, so you can retry without losing the notes. The desktop keeps the current version running until the package is ready.

## A deliberately long section

${Array.from({ length: 16 }, (_, index) => `Paragraph ${index + 1}. This release preserves selection, focus, wrapping, expansion, and reading position while bounded history keeps the window responsive.`).join("\n\n")}

[Read the full release notes](https://github.com/Tresnanda/kybern/releases/tag/v0.4.0)

END-OF-RELEASE-NOTES`,
  progress: null,
  error: null,
  errorKind: null,
  checkedAt: Date.parse("2026-09-14T10:00:00Z"),
  announcementOpen: true,
  detailsOpen: false,
}
const captureNotes = `<!-- kybern-release-title: Bring your agents together -->
<!-- kybern-release-summary: Delegate across harnesses, keep project knowledge with a coordinator, and follow the work from your chats. -->

- Ask agents to read earlier conversations and delegate work across installed harnesses.
- Create a project coordinator that plans work and maintains shared project knowledge.
- Choose the tools you want in the right sidebar and keep those choices between sessions.`

function applyTheme(variant: "dark" | "light") {
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
  for (const [name, value] of Object.entries(built.variables))
    root.style.setProperty(name, value)
  root.style.setProperty(
    "--app-opaque-content-surface",
    built.variables["--color-background-surface"]!
  )
}

if (__UPDATE_REDUCED_MOTION__) {
  const original = window.matchMedia.bind(window)
  window.matchMedia = (query: string) =>
    query.includes("prefers-reduced-motion")
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => true,
        } as MediaQueryList)
      : original(query)
}

async function run() {
  applyTheme(__UPDATE_THEME__ === "light" ? "light" : "dark")
  fixtureInstall.reset()
  useAppUpdate.setState({ ...state, announcementOpen: false })
  const { AppUpdateSurface, SidebarUpdateButton } =
    await import("../src/views/AppUpdate")

  function Fixture() {
    return (
      <ThemeProviderContext
        value={{
          theme: __UPDATE_THEME__,
          translucent: false,
          setTheme: () => {},
          setTranslucent: () => {},
        }}
      >
        <>
          <SidebarProvider className="h-dvh min-h-0 bg-[var(--app-shell-background)] text-foreground">
            <aside className="hidden w-64 shrink-0 flex-col border-e border-[color:var(--app-surface-divider)] bg-[var(--sidebar-background)] p-2 md:flex">
              <div className="h-[46px] drag-region" />
              <div className="px-2 text-[17px] font-medium">kybern</div>
              <div className="mt-5 px-2 text-xs text-muted-foreground">
                Projects
              </div>
              <div className="mt-2 rounded-lg bg-[var(--sidebar-accent)] px-2 py-2 text-sm">
                Release verification
              </div>
              <div className="mt-auto">
                <SidebarUpdateButton />
              </div>
            </aside>
            <main className="relative flex min-w-0 flex-1 flex-col bg-[var(--color-background-surface)] p-5 sm:p-8">
              <label
                className="mx-auto mt-12 w-full max-w-xl text-sm text-muted-foreground"
                htmlFor="typing-probe"
              >
                Message
              </label>
              <textarea
                id="typing-probe"
                data-testid="composer-editor"
                className="mx-auto mt-2 min-h-28 w-full max-w-xl resize-none rounded-xl border border-[color:var(--app-surface-divider)] bg-transparent p-4 text-foreground outline-none focus:ring-2 focus:ring-ring"
                defaultValue="Plan the next release."
              />
            </main>
          </SidebarProvider>
          <AppUpdateSurface />
        </>
      </ThemeProviderContext>
    )
  }

  flushSync(() =>
    createRoot(document.getElementById("root")!, {
      onUncaughtError: (error) =>
        report({ fixture: "app-update", pass: false, error: String(error) }),
    }).render(<Fixture />)
  )
  const probe = document.getElementById("typing-probe") as HTMLTextAreaElement
  probe.focus()
  probe.setSelectionRange(probe.value.length, probe.value.length)
  await sleep(100)
  useAppUpdate.setState({ announcementOpen: true })
  await waitFor(
    () =>
      visible(document.querySelector('[data-testid="update-announcement"]')),
    "announcement becomes visible"
  )

  const card = document.querySelector<HTMLElement>(
    '[data-testid="update-announcement"]'
  )
  if (!visible(card))
    throw new Error(
      `announcement is visible: ${JSON.stringify({ exists: !!card, className: card?.className, style: card ? { display: getComputedStyle(card).display, visibility: getComputedStyle(card).visibility, opacity: getComputedStyle(card).opacity } : null, state: useAppUpdate.getState() })}`
    )
  check(visible(card), "announcement is visible")
  check(
    card!.getAttribute("aria-label") === "Kybern update available",
    "announcement has an accessible name"
  )
  const cardRect = card!.getBoundingClientRect()
  const cardFits =
    cardRect.right <= innerWidth + 1 &&
    cardRect.bottom <= innerHeight + 1 &&
    cardRect.left >= -1 &&
    cardRect.top >= -1
  if (!cardFits)
    throw new Error(
      `announcement fits the window: ${JSON.stringify({ rect: cardRect.toJSON(), innerWidth, innerHeight, style: { position: getComputedStyle(card!).position, right: getComputedStyle(card!).right, bottom: getComputedStyle(card!).bottom, display: getComputedStyle(card!).display, transform: getComputedStyle(card!).transform } })}`
    )
  check(cardFits, "announcement fits the window")
  check(
    cardRect.right > innerWidth / 2 && cardRect.bottom > innerHeight / 2,
    "announcement is anchored bottom-right"
  )
  check(
    !!card!.querySelector('img[src*="release-background.png"]'),
    "announcement uses the bundled release background"
  )
  check(!!card!.querySelector("svg"), "announcement uses the Kybern logo")
  check(
    document.activeElement === probe,
    "announcement does not steal typing focus"
  )
  check(
    Array.from(card!.querySelectorAll("button")).every((button) => {
      const rect = button.getBoundingClientRect()
      return (
        rect.left >= cardRect.left - 1 &&
        rect.right <= cardRect.right + 1 &&
        rect.bottom <= cardRect.bottom + 1
      )
    }),
    "announcement actions are not clipped"
  )

  toast("Fixture toast")
  await sleep(240)
  const toastNode = document.querySelector<HTMLElement>("[data-sonner-toast]")
  check(
    visible(toastNode) &&
      toastNode!.getBoundingClientRect().bottom <= cardRect.top + 1,
    "normal toast does not overlap the announcement"
  )

  await click("Dismiss update announcement", 650)
  check(
    !document.querySelector('[data-testid="update-announcement"]'),
    "dismiss removes the card after its exit"
  )
  check(
    !!document
      .querySelector("aside")
      ?.textContent?.includes("Update and restart") || innerWidth < 768,
    "sidebar update action remains after dismiss"
  )

  useAppUpdate.setState({ announcementOpen: true })
  await sleep(350)
  const reopenedCard = document.querySelector<HTMLElement>(
    '[data-testid="update-announcement"]'
  )
  const cardDetails = byLabel("See what’s new", reopenedCard!)
  if (!cardDetails) throw new Error("Card has no release details action")
  cardDetails.click()
  await sleep(300)
  const cardDialog = document.querySelector<HTMLElement>(
    '[data-testid="update-details"]'
  )
  check(visible(cardDialog), "card opens release details")
  await waitFor(
    () => cardDialog!.textContent?.includes("END-OF-RELEASE-NOTES"),
    "full release notes are mounted"
  )
  check(
    !cardDialog!.textContent?.includes("kybern-release-title"),
    "release metadata comments stay hidden"
  )
  const notesScroller = Array.from(
    cardDialog!.querySelectorAll<HTMLElement>("*")
  ).find((element) => element.scrollHeight > element.clientHeight + 20)
  check(!!notesScroller, "long release notes have a readable scroll region")
  notesScroller!.scrollTop = notesScroller!.scrollHeight
  await sleep(120)
  check(
    !!cardDialog!.querySelector(
      'a[href="https://github.com/Tresnanda/kybern/releases/tag/v0.4.0"]'
    ),
    "release notes preserve links"
  )
  const dialogRect = cardDialog!.getBoundingClientRect()
  check(
    dialogRect.left >= -1 &&
      dialogRect.top >= -1 &&
      dialogRect.right <= innerWidth + 1 &&
      dialogRect.bottom <= innerHeight + 1,
    "release details fit the window"
  )
  check(
    Array.from(cardDialog!.querySelectorAll<HTMLElement>("button")).every(
      (button) => {
        const rect = button.getBoundingClientRect()
        return (
          rect.left >= dialogRect.left - 1 &&
          rect.right <= dialogRect.right + 1 &&
          rect.bottom <= dialogRect.bottom + 1
        )
      }
    ),
    "release detail actions are not clipped"
  )
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    })
  )
  await sleep(420)
  check(
    !visible(document.querySelector('[data-testid="update-details"]')),
    "Escape closes card release details"
  )
  check(
    document.activeElement ===
      (innerWidth >= 768
        ? byLabel("See what’s new", document.querySelector("aside")!)
        : probe),
    "Escape returns focus to a visible update trigger"
  )

  if (innerWidth >= 768) {
    const sidebarDetails = await click("See what’s new")
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="update-details"]'
    )
    check(visible(dialog), "sidebar opens release details")
    await click("Close release details")
    check(
      !visible(document.querySelector('[data-testid="update-details"]')),
      "close action closes release details"
    )
    check(
      document.activeElement === sidebarDetails,
      "close action returns focus to the sidebar action"
    )
  } else {
    useAppUpdate.setState({ detailsOpen: true })
    await sleep(260)
    await click("Close release details")
    check(
      document.activeElement === probe,
      "narrow dialog returns focus to the typing probe"
    )
  }

  useAppUpdate.setState({
    ...state,
    announcementOpen: false,
    detailsOpen: innerWidth < 768,
    errorKind: null,
  })
  await sleep(220)
  const attemptsBeforeQuickUpdate = fixtureInstall.attempts
  await click("Update and restart", 80)
  await click("Updating… 42%", 260).catch(() => {})
  check(
    fixtureInstall.attempts === attemptsBeforeQuickUpdate + 1,
    "quick update invokes install exactly once"
  )
  const progressButton = byLabel("Updating… 68%") ?? byLabel("Updating…")
  check(
    progressButton instanceof HTMLButtonElement && progressButton.disabled,
    "install progress is visible and disabled"
  )

  useAppUpdate.setState({
    ...state,
    announcementOpen: false,
    detailsOpen: innerWidth < 768,
    errorKind: null,
  })
  fixtureInstall.failNext = true
  await sleep(120)
  const attemptsBeforeFailure = fixtureInstall.attempts
  await click("Update and restart", 280)
  check(
    fixtureInstall.attempts === attemptsBeforeFailure + 1,
    "failed install invokes one attempt"
  )
  check(
    useAppUpdate.getState().error?.includes("could not be verified"),
    "install failure stays visible"
  )
  check(!!byLabel("Retry update"), "install failure offers retry")
  const attemptsBeforeRetry = fixtureInstall.attempts
  await click("Retry update", 260)
  check(
    fixtureInstall.attempts === attemptsBeforeRetry + 1,
    "retry invokes one new install attempt"
  )
  check(
    useAppUpdate.getState().phase === "installing",
    "retry returns to install progress"
  )

  // Restore the requested capture mode after exercising the full interaction path.
  toast.dismiss()
  probe.focus()
  await sleep(__UPDATE_REDUCED_MOTION__ ? 30 : 350)
  useAppUpdate.setState({
    ...state,
    notes: captureNotes,
    announcementOpen: __UPDATE_VIEW__ === "card",
    detailsOpen: __UPDATE_VIEW__ === "details",
  })
  await sleep(__UPDATE_REDUCED_MOTION__ ? 80 : 650)
  check(
    document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
    "page has no horizontal overflow"
  )
  const finalSurface =
    __UPDATE_VIEW__ === "card"
      ? document.querySelector<HTMLElement>(
          '[data-testid="update-announcement"]'
        )
      : document.querySelector<HTMLElement>('[data-testid="update-details"]')
  check(visible(finalSurface), `capture mode ${__UPDATE_VIEW__} is visible`)
  const finalRect = finalSurface!.getBoundingClientRect()
  check(
    finalRect.left >= -1 &&
      finalRect.top >= -1 &&
      finalRect.right <= innerWidth + 1 &&
      finalRect.bottom <= innerHeight + 1,
    "capture surface fits the viewport"
  )
  report({
    fixture: "app-update",
    pass: Object.values(checks).every(Boolean),
    checks,
    view: __UPDATE_VIEW__,
    theme: __UPDATE_THEME__,
    reducedMotion: __UPDATE_REDUCED_MOTION__,
    width: innerWidth,
    height: innerHeight,
    installAttempts: fixtureInstall.attempts,
  })
}

window.addEventListener("error", (event) =>
  report({ fixture: "app-update", pass: false, error: event.message })
)
window.addEventListener("unhandledrejection", (event) =>
  report({ fixture: "app-update", pass: false, error: String(event.reason) })
)
run().catch((error) =>
  report({
    fixture: "app-update",
    pass: false,
    error: String(error),
    checks,
    card: (() => {
      const node = document.querySelector<HTMLElement>(
        '[data-testid="update-announcement"]'
      )
      return node
        ? {
            html: node.outerHTML.slice(0, 2400),
            opacity: getComputedStyle(node).opacity,
            display: getComputedStyle(node).display,
            position: getComputedStyle(node).position,
            rect: node.getBoundingClientRect().toJSON(),
          }
        : null
    })(),
  })
)
