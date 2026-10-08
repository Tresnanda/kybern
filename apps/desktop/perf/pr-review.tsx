import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThemeProviderContext } from "../src/components/theme-context"
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
} from "../src/lib/kit/theme/theme.logic"
import { PrReviewDock } from "../src/views/PrReview"
import { PullRequests } from "../src/views/PullRequests"
import { WorktreeCleanupDialog } from "../src/views/WorktreeCleanup"
import { useReviews, reviewKey, updateReviewDraft } from "../src/state/prReview"
import { useStore } from "../src/state/store"
import type { Settings, Thread } from "../src/protocol"
import { detail, reviewFixture } from "./pr-review-rpc"
import "../src/index.css"

declare const __ORCH_THEME__: "light" | "dark"
declare const __COLLAB_STRESS__: string
const theme = __ORCH_THEME__
const stress = __COLLAB_STRESS__
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const post = (value: unknown) =>
  (
    window as unknown as {
      webkit?: {
        messageHandlers?: { bench?: { postMessage: (value: string) => void } }
      }
    }
  ).webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}
async function screenshot(name: string) {
  if (!(window as unknown as { webkit?: unknown }).webkit) return
  const finiteEntries = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === "running" &&
        Number.isFinite(animation.effect?.getComputedTiming().endTime)
    )
  await Promise.race([
    Promise.allSettled(finiteEntries.map((animation) => animation.finished)),
    sleep(1500),
  ])
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
  await new Promise<void>((resolve) => {
    ;(
      window as unknown as { __screenshotContinue: () => void }
    ).__screenshotContinue = resolve
    post({
      screenshot: `${name}-${theme}-${innerWidth}${stress ? `-${stress}` : ""}`,
    })
  })
}
export function Shell() {
  const dock = useStore((state) => state.rightTab === "review")
  const active = useStore((state) => state.rightOpen)
  return (
    <ThemeProviderContext
      value={{
        theme,
        translucent: false,
        setTheme: () => {},
        setTranslucent: () => {},
      }}
    >
      <main className="flex h-screen min-w-0 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          {(!dock || innerWidth >= 1000) && <PullRequests />}
          {dock && (
            <aside
              className="flex min-h-0 min-w-0 flex-col border-s border-[color:var(--color-border)]"
              style={{
                width: innerWidth >= 1000 ? 360 : "100%",
                flexShrink: 0,
              }}
            >
              <PrReviewDock threadId="repair" active={active} />
            </aside>
          )}
        </div>
        <WorktreeCleanupDialog />
      </main>
    </ThemeProviderContext>
  )
}
const visible = (element: HTMLElement) =>
  element.getClientRects().length > 0 &&
  !element.closest('[aria-hidden="true"]')
function reviewRoot() {
  return (
    document.querySelector<HTMLElement>('[data-review-mode="dock"]') ??
    document.querySelector<HTMLElement>('[data-review-mode="page"]') ??
    document.body
  )
}
function button(label: string) {
  const selector = 'button,[role="menuitem"]'
  const element = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"] button'),
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ...reviewRoot().querySelectorAll<HTMLElement>(selector),
    ...document.querySelectorAll<HTMLElement>(selector),
  ].find(
    (candidate) =>
      visible(candidate) &&
      (candidate.getAttribute("aria-label") === label ||
        candidate.textContent?.trim() === label)
  )
  if (!element) throw new Error(`Missing button ${label}`)
  return element
}
async function click(label: string) {
  button(label).click()
  await sleep(120)
}
function buttonMatching(pattern: RegExp) {
  const element = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"] button'),
    ...document.querySelectorAll<HTMLElement>("button"),
  ].find(
    (candidate) =>
      visible(candidate) &&
      (pattern.test(candidate.getAttribute("aria-label") ?? "") ||
        pattern.test(candidate.textContent?.trim() ?? ""))
  )
  if (!element) throw new Error(`Missing button ${pattern}`)
  return element
}
async function clickTab(name: string) {
  const tab = [
    ...reviewRoot().querySelectorAll<HTMLElement>('[role="tab"]'),
  ].find((candidate) => candidate.textContent?.trim().startsWith(name))
  if (!tab) throw new Error(`Missing tab ${name}`)
  tab.click()
  await sleep(160)
}
/** Refresh through the icon when the top bar shows it, else through More actions. */
async function refreshPr() {
  const icon = reviewRoot().querySelector<HTMLElement>(
    '[aria-label="Refresh pull request"]'
  )
  if (icon && visible(icon)) {
    icon.click()
    await sleep(120)
    return
  }
  await click("More actions")
  await click("Refresh")
}
async function openReview() {
  if (!document.querySelector("[data-pr-review-popover]"))
    reviewRoot()
      .querySelector<HTMLElement>('button[aria-label^="Review"]')!
      .click()
  await waitFor(
    () => !!document.querySelector("[data-pr-review-popover]"),
    "Review popover did not open"
  )
  await sleep(120)
}
async function closePopover() {
  const cancel = [
    ...document.querySelectorAll<HTMLElement>("[data-pr-review-popover] button"),
  ].find((candidate) => candidate.textContent?.trim() === "Cancel")
  cancel?.click()
  await waitFor(
    () => !document.querySelector("[data-pr-review-popover]"),
    "Review popover did not close"
  )
}
async function openSend() {
  reviewRoot()
    .querySelector<HTMLElement>('button[aria-label^="Send to agent"]')!
    .click()
  await waitFor(
    () => !!document.querySelector("[data-pr-send-popover]"),
    "Send popover did not open"
  )
  await sleep(120)
}
const callCount = (method: string) =>
  reviewFixture.calls.filter((call) => call.method === method).length
async function waitFor(
  condition: () => boolean,
  message: string,
  timeout = 2000
) {
  const deadline = performance.now() + timeout
  while (!condition() && performance.now() < deadline) await sleep(20)
  check(condition(), message)
}
function write(id: string, value: string) {
  const textarea = document.getElementById(id) as
    HTMLTextAreaElement | HTMLInputElement
  check(textarea, `Missing input ${id}`)
  textarea.focus()
  Object.getOwnPropertyDescriptor(
    textarea.tagName === "INPUT"
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype,
    "value"
  )!.set!.call(textarea, value)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}
async function run() {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.dataset.themeVariant = theme
  document.documentElement.dataset.runtime = "electron"
  document.documentElement.dataset.platform = "macos"
  const built = buildThemeCssVariables(
    {
      codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme],
      theme: DEFAULT_THEME_STATE.chromeThemes[theme],
    },
    theme,
    { electron: true, isMac: true, systemUiFont: true }
  )
  for (const [name, value] of Object.entries(built.variables))
    document.documentElement.style.setProperty(name, value)
  if (stress === "large-text") {
    document.documentElement.style.setProperty("--app-font-size-ui", "24px")
    document.documentElement.style.fontSize = "32px"
  }
  if (stress === "rtl") document.documentElement.dir = "rtl"
  const rootRem = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize
  )
  const at = "2026-10-08T00:00:00Z"
  const thread: Thread = {
    id: "repair",
    title: "Repair review findings",
    project_id: "project",
    provider: { kind: "codex", instance: "default" },
    permission_mode: "supervised",
    status: "idle",
    cwd: "/scratch/managed/repair",
    worktree: { path: "/scratch/managed/repair", branch: "feature/review" },
    pinned: false,
    created_at: at,
    updated_at: at,
    last_seq: 0,
  }
  useStore.getState().set({
    environmentId: "review-fixture",
    rightTab: null,
    rightOpen: false,
    prSelection: null,
    rightTabs: [],
    projects: {
      project: {
        id: "project",
        name: "Review fixture",
        path: "/scratch",
        is_git: true,
        created_at: at,
        updated_at: at,
      },
    },
    threads: { repair: thread },
    settings: {
      default_provider: "codex",
      default_permission_mode: "supervised",
    } as Settings,
    gitStatuses: {
      repair: {
        is_git: true,
        branch: "feature/review",
        dirty_files: 0,
        ahead: 0,
        behind: 0,
        pull_request: detail.pull_request,
      },
    },
  })
  const key = reviewKey("project", 24)
  localStorage.removeItem(`kybern.pr.draft:${key}`)
  // First load: hold the list so the skeleton can be captured.
  reviewFixture.listDelay = 2500
  flushSync(() =>
    createRoot(document.getElementById("root")!, {
      onUncaughtError: (error) => post({ pass: false, error: String(error) }),
    }).render(<Shell />)
  )
  await waitFor(
    () => !!document.querySelector('[aria-label="Loading pull requests"]'),
    "Loading skeleton missing"
  )
  check(
    document.querySelectorAll('[aria-label="Loading pull requests"] > div')
      .length === 8,
    "The loading skeleton is not eight rows"
  )
  await screenshot("pr-loading")
  reviewFixture.listDelay = 0
  await waitFor(
    () => !!document.getElementById("pr-row-project-24"),
    "Pull request list did not load",
    6000
  )
  const rows = [...document.querySelectorAll<HTMLElement>(".pr-row")]
  check(rows.length >= 5, "List rows missing")
  check(
    rows.every((row) => row.children.length === 2),
    "A row is not exactly two lines"
  )
  check(
    !rows.some((row) => /\bOpen\b|Draft/.test(row.textContent ?? "")),
    "A row repeats the state word or a Draft pill"
  )
  check(
    !rows.some((row) => row.textContent?.includes("feature/")),
    "A row shows a branch name"
  )
  check(
    document
      .getElementById("pr-row-project-27")!
      .querySelector('[aria-label="Has conflicts"]') !== null,
    "The conflicting row lost its conflict glyph"
  )
  check(
    document
      .getElementById("pr-row-project-28")!
      .querySelector('[aria-label="Draft"]') !== null,
    "The draft row lost its draft glyph"
  )
  check(
    document
      .getElementById("pr-row-project-24")!
      .querySelector('[role="img"][aria-label^="Checks:"]')
      ?.getAttribute("aria-label") === "Checks: 1 failing of 100",
    "The CI dot does not match the checks summary"
  )
  check(
    !document
      .getElementById("pr-row-project-27")!
      .querySelector('[aria-label^="Checks:"]'),
    "A PR without checks shows a CI dot"
  )
  const inbox = document.querySelector<HTMLElement>(".pr-inbox")!
  const list = document.querySelector<HTMLElement>(
    '[aria-label="Pull requests list"]'
  )!
  const wide = inbox.clientWidth >= 52 * rootRem
  check(
    getComputedStyle(
      document.querySelector<HTMLElement>(".pr-inbox-placeholder")!
    ).display !== "none" === wide,
    "Empty selection did not follow the inbox width"
  )
  if (wide) await screenshot("pr-no-selection")
  // Keyboard: roving focus walks the rows; moving focus never loads a pull request.
  const detailCallsBefore = callCount("github.pr.detail")
  const rowButtons = () =>
    [...document.querySelectorAll<HTMLButtonElement>("[data-pr-row]")]
  check(
    rowButtons().filter((b) => b.tabIndex === 0).length === 1,
    "The list does not have exactly one tab stop"
  )
  rowButtons()[0].focus()
  for (let i = 0; i < 2; i++)
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    )
  check(
    document.activeElement === rowButtons()[2],
    "Arrow keys did not move focus to the third row"
  )
  check(
    callCount("github.pr.detail") === detailCallsBefore,
    "Moving focus fetched pull request details"
  )
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true })
  )
  check(
    document.activeElement === rowButtons().at(-1),
    "End did not focus the last row"
  )
  rowButtons()[2].focus()
  ;(document.activeElement as HTMLElement).click() // Enter on a button is a click.
  await waitFor(
    () => useStore.getState().prSelection?.number === 26,
    "Enter did not open the third row"
  )
  await waitFor(
    () => callCount("github.pr.detail") === detailCallsBefore + 1,
    "Opening a row did not load exactly one detail"
  )
  document.getElementById("pr-row-project-24")!.click()
  await waitFor(
    () => !!useReviews.getState().entries[key]?.detail,
    "Selected pull request did not load"
  )
  check(
    useReviews.getState().entries[key].workspace === "overview",
    "New review did not open on Summary"
  )
  check(
    !document.querySelector("[data-pr-diff]"),
    "Summary mounted a hidden diff"
  )
  check(
    !reviewFixture.calls.some((call) => call.method === "github.pr.page"),
    "Summary eagerly downloaded changes"
  )
  check(
    visible(list) === wide || !useStore.getState().prSelection,
    "List/detail did not adapt to its available pane width"
  )
  check(
    document.querySelectorAll('[aria-label="Pull request details"]').length ===
      1,
    "The info column is not rendered exactly once"
  )
  const reviewPane = document.querySelector<HTMLElement>(
    '[data-review-mode="page"]'
  )!
  const infoColumn = reviewPane.clientWidth >= 52 * rootRem
  check(
    (getComputedStyle(reviewPane.querySelector(".pr-info")!).position ===
      "sticky") === infoColumn,
    "The info column did not adapt to its detail width"
  )
  if (infoColumn)
    check(
      Math.abs(
        reviewPane.querySelector(".pr-info")!.getBoundingClientRect().width -
          18 * rootRem
      ) < 2,
      "The info column is not 18rem wide"
    )
  check(
    document.documentElement.scrollWidth <= innerWidth + 2,
    "The summary scrolls horizontally"
  )
  check(
    document
      .querySelector('[aria-label="Pull request description"]')
      ?.textContent?.includes("Preserve unsent drafts"),
    "Summary description is not open"
  )
  check(
    document
      .querySelector('[aria-label="Pull request checks"]')
      ?.textContent?.includes("Desktop checks"),
    "Summary checks missing"
  )
  check(
    document
      .querySelector('[aria-label="Pull request checks"]')
      ?.textContent?.includes("1 failing · 1 running · 98 passed"),
    "Checks phrase missing"
  )
  const tabLabels = [
    ...reviewPane.querySelectorAll('[role="tab"]'),
  ].map((tab) => tab.textContent ?? "")
  check(
    tabLabels[1]?.includes("+1,284") && tabLabels[1].includes("−612"),
    "Changes tab lost its diff stat"
  )
  check(tabLabels[2]?.includes("4"), "Timeline tab lost its comment count")
  const topbar = reviewPane.querySelector<HTMLElement>(".pr-topbar")!
  const folded = topbar.clientWidth < 46 * rootRem
  check(
    visible(reviewPane.querySelector<HTMLElement>(".pr-topbar-more")!) ===
      folded,
    "The More menu did not follow the 46rem threshold"
  )
  check(
    visible(reviewPane.querySelector<HTMLElement>(".pr-topbar-icons")!) ===
      !folded,
    "The icon actions did not follow the 46rem threshold"
  )
  await openReview()
  write("review-page-24", "Draft summary retained across views")
  await screenshot("pr-review-popover")
  await closePopover()
  if (!wide) {
    await click("Back to pull requests")
    check(
      document.activeElement?.id === "pr-row-project-24",
      "Back did not restore selected row focus"
    )
    write("pr-search", "draft")
    await sleep(100)
    document.getElementById("pr-row-project-24")!.click()
    await sleep(100)
    check(
      (document.getElementById("pr-search") as HTMLInputElement).value ===
        "draft",
      "Back discarded the list filter"
    )
    // Esc in single-pane mode returns to the list with focus on the row.
    document
      .querySelector(".pr-review-scroll")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    await sleep(160)
    check(
      document.activeElement?.id === "pr-row-project-24" &&
        useStore.getState().prSelection === null,
      "Esc did not return to the list with focus on the row"
    )
    document.getElementById("pr-row-project-24")!.click()
    await sleep(100)
  } else {
    document.getElementById("pr-row-project-25")!.click()
    await waitFor(
      () =>
        !!document
          .querySelector(".pr-review h2")
          ?.textContent?.includes("keyboard navigation"),
      "Master/detail row selection failed"
    )
    document.getElementById("pr-row-project-24")!.click()
    await sleep(100)
  }
  check(
    useReviews.getState().entries[key].draft.body ===
      "Draft summary retained across views",
    "Selecting a PR discarded its draft"
  )
  const originalTitle = detail.pull_request.title
  detail.pull_request.title =
    "Preserve review drafts and exact inline comment anchors when GitHub rejects a request while a reviewer keeps typing in another conversation pane"
  await refreshPr()
  check(
    document.querySelector(".pr-review h2")?.textContent ===
      detail.pull_request.title,
    "Long title was truncated"
  )
  check(
    document.documentElement.scrollWidth <= innerWidth + 2,
    "Long title overflowed the viewport"
  )
  detail.pull_request.title = originalTitle
  await refreshPr()
  const resetScroll = () =>
    document
      .querySelectorAll<HTMLElement>("[data-pr-scroll]")
      .forEach((element) => {
        element.scrollTop = 0
      })
  resetScroll()
  await screenshot("pr-list-summary")
  if (!wide) await screenshot("pr-narrow-detail")
  await clickTab("Changes")
  await waitFor(
    () => !!document.querySelector("[data-pr-diff]"),
    "Changes did not lazily load its selected diff"
  )
  check(
    document.querySelectorAll("tr").length <= 610,
    "Large diff exceeded initial line budget"
  )
  check(
    document.querySelectorAll('[aria-label="Changed files"] button[aria-pressed]')
      .length === 30,
    "File page lost items"
  )
  check(
    document.querySelectorAll("[data-pr-diff]").length === 1,
    "More than the selected file is mounted"
  )
  resetScroll()
  await click("Comment on new line 7")
  const composer = document.getElementById("inline-page-24")!
  check(
    composer.closest("tr")?.previousElementSibling?.querySelector(
      '[aria-label="Comment on new line 7"]'
    ),
    "The inline composer is not directly under line 7"
  )
  write("inline-page-24", "Preserve this inline draft")
  await click("Add to review")
  check(
    useReviews.getState().entries[key].draft.inline[0]?.side === "RIGHT",
    "Inline draft lost its line side"
  )
  check(
    [...document.querySelectorAll("[data-pr-diff] tr")].some((row) =>
      row.textContent?.includes("Preserve this inline draft")
    ),
    "The saved inline draft is not under its line"
  )
  check(
    document.documentElement.scrollWidth <= innerWidth + 2,
    "Changes scroll horizontally"
  )
  await screenshot("pr-changes-inline")
  await clickTab("Timeline")
  await waitFor(
    () =>
      !!reviewRoot().querySelector('[aria-label="Select finding by reviewer"]'),
    "Timeline did not load"
  )
  reviewRoot()
    .querySelector<HTMLElement>('[aria-label="Select finding by reviewer"]')!
    .click()
  await click("Reviews")
  reviewRoot()
    .querySelector<HTMLElement>('[aria-label="Select finding by reviewer"]')!
    .click()
  await click("Inline comments")
  reviewRoot()
    .querySelector<HTMLElement>('[aria-label="Select finding by reviewer"]')!
    .click()
  check(
    useReviews.getState().entries[key].draft.selected.length === 3,
    "Timeline source IDs collided or selection disappeared"
  )
  check(
    !!document.querySelector('[aria-label="Selected findings"]'),
    "The selection bar is missing"
  )
  await click("Next page")
  check(
    useReviews.getState().entries[key].page?.page === 2,
    "Timeline pagination did not advance"
  )
  check(
    useReviews.getState().entries[key].draft.selected.length === 3,
    "Paging discarded selected findings"
  )
  check(
    !document.querySelector("[data-pr-diff]"),
    "Timeline retained an offscreen diff"
  )
  resetScroll()
  await screenshot("pr-timeline-selected")
  await openSend()
  check(
    document.querySelector("[data-pr-send-popover]")?.textContent?.includes(
      "3 comments and 1 inline draft"
    ),
    "Send popover miscounted the findings"
  )
  await screenshot("pr-send-popover")
  document
    .querySelector<HTMLElement>("[data-pr-send-popover]")!
    .closest('[data-slot="popover-popup"]')
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await sleep(200)
  flushSync(() =>
    useStore.getState().set({ rightTab: "review", rightOpen: true })
  )
  await sleep(180)
  await openReview()
  check(
    (document.getElementById("review-dock-24") as HTMLTextAreaElement).value ===
      "Draft summary retained across views",
    "Page and dock lost their shared summary"
  )
  check(
    document
      .querySelector("[data-pr-review-popover]")
      ?.textContent?.includes("1 inline comment"),
    "Dock lost the saved inline draft"
  )
  await closePopover()
  resetScroll()
  await screenshot("pr-dock")
  const callsBeforeHide = reviewFixture.calls.length
  flushSync(() => useStore.getState().set({ rightOpen: false }))
  await sleep(100)
  check(
    !document.querySelector('[data-review-mode="dock"]'),
    "Inactive dock retained mounted content"
  )
  check(
    reviewFixture.calls.length === callsBeforeHide,
    "Inactive dock loaded GitHub data"
  )
  flushSync(() => useStore.getState().set({ rightOpen: true }))
  await sleep(100)
  await openReview()
  reviewFixture.failSubmit = true
  await click("Post comment and 1 inline draft")
  check(
    document.querySelector('[data-pr-review-popover] [role="alert"]'),
    "Failure was not actionable and inline"
  )
  check(
    useReviews.getState().entries[key].draft.inline.length === 1,
    "Failed post cleared inline draft"
  )
  reviewFixture.failSubmit = false
  reviewFixture.slowSubmit = true
  button("Post comment and 1 inline draft").click()
  await sleep(50)
  write("review-dock-24", "Keep this newer draft")
  await sleep(500)
  check(
    useReviews.getState().entries[key].draft.body === "Keep this newer draft",
    "Slow submission erased new typing"
  )
  check(
    !useReviews.getState().entries[key].draft.inline.length,
    "Successful post did not remove submitted inline draft"
  )
  reviewFixture.slowSubmit = false
  const tabs = Array.from(
    reviewRoot().querySelectorAll<HTMLButtonElement>(
      '[aria-label="Review workspace"] [role="tab"]'
    )
  )
  tabs[0].focus()
  tabs[0].dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true })
  )
  await sleep(100)
  check(
    document.activeElement?.id.endsWith("-conversation") === true,
    "End did not focus Timeline"
  )
  check(
    useReviews.getState().entries[key].workspace === "conversation",
    "Keyboard did not select Timeline"
  )
  tabs[2].dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true })
  )
  await sleep(100)
  check(
    useReviews.getState().entries[key].workspace === "overview",
    "Home did not return to Summary"
  )
  if (stress === "rtl") {
    tabs[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
    )
    await sleep(100)
    check(
      document.activeElement?.id.endsWith("-conversation") === true,
      "RTL ArrowRight did not move toward the previous tab"
    )
    tabs[2].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
    )
    await sleep(100)
    check(
      document.activeElement?.id.endsWith("-overview") === true,
      "RTL ArrowLeft did not move toward the next tab"
    )
  }
  reviewRoot().querySelector<HTMLElement>(".pr-checks-toggle")!.click()
  await sleep(120)
  check(
    reviewRoot().querySelectorAll(".pr-checks-rows li").length === 100,
    "Show all did not expand the checks in place"
  )
  await click("Load more checks")
  check(
    reviewRoot().textContent?.includes("Check 1.0"),
    "Complete check page missing"
  )
  await click("Next page")
  check(
    useReviews.getState().entries[key].page?.page === 2,
    "Checks pagination did not advance"
  )
  await clickTab("Changes")
  await click("Next page")
  check(
    useReviews.getState().entries[key].page?.page === 2,
    "File pagination did not advance"
  )
  check(
    Array.from(document.querySelectorAll("[data-pr-diff]")).every(
      (diff) => diff.querySelectorAll("tr").length <= 610
    ),
    "A pane mounted cumulative diffs"
  )
  resetScroll()
  await clickTab("Summary")
  const bodyBeforeNewHead = useReviews.getState().entries[key].draft.body
  const pageCallsBeforeNewHead = reviewFixture.calls.filter(
    (call) => call.method === "github.pr.page" && call.params.kind === "files"
  ).length
  detail.head_sha = "reviewed-head-updated"
  await refreshPr()
  check(
    useReviews.getState().entries[key].page === null,
    "Summary refresh retained a diff from the prior head"
  )
  await clickTab("Changes")
  await waitFor(
    () =>
      useReviews.getState().entries[key].file ===
      "src/reviews/submission-updated.ts",
    "Changes reused the prior head's cached file page"
  )
  check(
    reviewFixture.calls.filter(
      (call) => call.method === "github.pr.page" && call.params.kind === "files"
    ).length ===
      pageCallsBeforeNewHead + 1,
    "Changed head did not fetch exactly one fresh file page"
  )
  check(
    useReviews.getState().entries[key].draft.body === bodyBeforeNewHead,
    "New head discarded the retained draft"
  )
  check(
    reviewRoot().querySelector("[data-stale-dot]"),
    "Changed head did not mark the Review button"
  )
  await openReview()
  check(
    document
      .querySelector("[data-pr-review-popover]")
      ?.textContent?.includes("This draft refers to"),
    "Changed head did not warn about stale draft"
  )
  check(
    (buttonMatching(/^Post comment$/) as HTMLButtonElement).disabled,
    "Stale summary remained publishable"
  )
  await click("Use draft text for current commit")
  check(
    useReviews.getState().entries[key].draft.sourceHead === detail.head_sha,
    "Explicit draft reuse did not bind current commit"
  )
  // Approve is confirmed by choosing it and pressing submit: no second dialog.
  document
    .querySelector<HTMLInputElement>('[data-pr-review-popover] input[value="approve"]')!
    .click()
  await sleep(80)
  check(
    buttonMatching(/^Approve$/) instanceof HTMLButtonElement,
    "The submit button is not labelled Approve"
  )
  const approvals = () =>
    reviewFixture.calls.filter(
      (call) =>
        call.method === "github.pr.action" && call.params.action === "approve"
    ).length
  check(approvals() === 0, "Approve fired before submit")
  const submit = [
    ...document.querySelectorAll<HTMLButtonElement>(
      "[data-pr-review-popover] button"
    ),
  ].find((candidate) => candidate.textContent?.trim() === "Approve")!
  submit.click()
  await waitFor(() => approvals() === 1, "Approve did not call GitHub once")
  await sleep(200)
  check(
    !document.querySelector('[data-slot="dialog-popup"]'),
    "Approve opened a second confirmation dialog"
  )
  // Merge and Close still confirm.
  await click("Merge")
  check(
    document
      .querySelector('[data-slot="dialog-popup"]')
      ?.textContent?.includes("Merge pull request?"),
    "Merge skipped explicit confirmation"
  )
  await click("Cancel")
  await click("More merge options")
  await click("Close pull request")
  check(
    document
      .querySelector('[data-slot="dialog-popup"]')
      ?.textContent?.includes("Close pull request?"),
    "Close skipped explicit confirmation"
  )
  await click("Cancel")
  useStore.getState().set({ worktreeCleanupThread: "repair" })
  await sleep(160)
  check(
    (button("Remove worktree") as HTMLButtonElement).disabled,
    "Dirty/unmerged cleanup did not require explicit confirmation"
  )
  const confirm = document.querySelector<HTMLElement>('[role="checkbox"]')!
  confirm.click()
  await sleep(60)
  await screenshot("worktree-confirmation")
  await click("Remove worktree anyway")
  check(
    reviewFixture.calls.some(
      (call) =>
        call.method === "threads.worktree.remove" && call.params.force === true
    ),
    "Confirmed cleanup did not use force"
  )
  await click("Done")
  updateReviewDraft(key, {
    inline: [
      {
        path: "src/reviews/submission.ts",
        line: 7,
        side: "RIGHT",
        body: "Repair this finding",
      },
    ],
    threadId: "repair",
  })
  await sleep(60)
  await openSend()
  await click("Send 4 findings")
  await waitFor(
    () => reviewFixture.sent.length >= 1,
    "Explicit repair did not finish checkout and send within two seconds"
  )
  const repairCheckouts = reviewFixture.calls.filter(
    (call) =>
      call.method === "github.pr.action" && call.params.action === "checkout"
  )
  check(repairCheckouts.length === 1, "Repair did not check out exactly once")
  check(
    repairCheckouts[0].params.for_repair === true &&
      repairCheckouts[0].params.head_sha === detail.head_sha &&
      repairCheckouts[0].params.thread_id === "repair" &&
      reviewFixture.checkedOut?.branch === detail.pull_request.head,
    "Repair checkout did not verify its target and reviewed head"
  )
  check(
    reviewFixture.repairSteps.length === 2 &&
      reviewFixture.repairSteps[0].kind === "checkout" &&
      reviewFixture.repairSteps[1].kind === "send" &&
      reviewFixture.repairSteps.every(
        (step) => step.threadId === "repair" && step.headSha === detail.head_sha
      ),
    "Repair sent before the reviewed head was checked out"
  )
  check(
    reviewFixture.sent.length === 1,
    "Explicit repair did not send exactly once"
  )
  check(
    JSON.stringify(reviewFixture.sent[0].message).includes(detail.head_sha),
    "Repair lost reviewed head context"
  )
  check(
    !reviewFixture.calls.some(
      (call) =>
        call.method === "github.pr.action" && call.params.action === "merge"
    ),
    "Repair unexpectedly merged"
  )
  // List states: empty filter, search miss, GitHub CLI problems and first load.
  flushSync(() => useStore.getState().set({ rightOpen: false, rightTab: null }))
  await sleep(200)
  const bodyText = () => document.querySelector(".pr-inbox-list")?.textContent ?? ""
  if (!wide) {
    useStore.getState().set({ prSelection: null })
    await sleep(120)
  }
  write("pr-search", "no such pull request")
  await waitFor(() => bodyText().includes("No results for"), "Search miss state missing")
  await screenshot("pr-search-miss")
  write("pr-search", "")
  await sleep(100)
  await click("Closed")
  await waitFor(
    () => bodyText().includes("No closed pull requests"),
    "Empty filter state missing"
  )
  check(bodyText().includes("Show all pull requests"), "Empty filter lacks its action")
  await screenshot("pr-empty")
  await click("Open")
  await sleep(150)
  reviewFixture.ghError = "auth"
  await click("Refresh")
  await waitFor(
    () => !!document.querySelector('[data-gh-problem="gh-auth"]'),
    "Signed-out state missing"
  )
  check(bodyText().includes("Copy command"), "Signed-out state lacks Copy command")
  await screenshot("pr-gh-auth")
  reviewFixture.ghError = "missing"
  await click("Refresh")
  await waitFor(
    () => !!document.querySelector('[data-gh-problem="gh-missing"]'),
    "Missing gh state missing"
  )
  check(bodyText().includes("Open install guide"), "Missing gh state lacks its guide")
  reviewFixture.ghError = null
  post({
    pass: true,
    fixture: "pr-review",
    theme,
    stress,
    rootRem,
    largeText: stress === "large-text",
    rtl: stress === "rtl",
    width: innerWidth,
    mountedDiffRows: document.querySelectorAll("tr").length,
    twoLineRows: true,
    roveFocus: true,
    singleInfoColumn: true,
    inlineUnderLine: true,
    approveWithoutDialog: true,
    ghStates: true,
    sharedDrafts: true,
    retainedFailureDrafts: true,
    keyboardWorkspace: true,
    lazyOverview: true,
    responsiveMasterDetail: true,
    conversationPagination: true,
    staleDraftReuse: true,
    confirmations: true,
    cleanupConfirmation: true,
    checkoutForRepair: true,
    explicitRepair: true,
  })
}
run().catch((error) =>
  post({ pass: false, fixture: "pr-review", error: String(error) })
)
