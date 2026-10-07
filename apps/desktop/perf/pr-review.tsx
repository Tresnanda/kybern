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
async function waitFor(condition: () => boolean, message: string) {
  const deadline = performance.now() + 2000
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
  flushSync(() =>
    createRoot(document.getElementById("root")!, {
      onUncaughtError: (error) => post({ pass: false, error: String(error) }),
    }).render(<Shell />)
  )
  await waitFor(
    () => !!document.getElementById("pr-row-project-24"),
    "Pull request list did not load"
  )
  document.getElementById("pr-row-project-24")!.click()
  await waitFor(
    () => !!useReviews.getState().entries[key]?.detail,
    "Selected pull request did not load"
  )
  check(
    useReviews.getState().entries[key].workspace === "overview",
    "New review did not open on Overview"
  )
  check(
    !document.querySelector("[data-pr-diff]"),
    "Overview mounted a hidden diff"
  )
  check(
    !reviewFixture.calls.some((call) => call.method === "github.pr.page"),
    "Overview eagerly downloaded changes"
  )
  const inbox = document.querySelector<HTMLElement>(".pr-inbox")!
  const list = document.querySelector<HTMLElement>(
    '[aria-label="Pull requests list"]'
  )!
  check(
    visible(list) === inbox.clientWidth >= 60 * rootRem,
    "List/detail did not adapt to its available pane width"
  )
  check(
    !!document.querySelector('[aria-label="Pull request details"]'),
    "Metadata disappeared"
  )
  const reviewPane = document.querySelector<HTMLElement>(
    '[data-review-mode="page"]'
  )!
  const bodyColumns = getComputedStyle(
    reviewPane.querySelector(".pr-review-body")!
  ).gridTemplateColumns.split(/\s+/).length
  check(
    bodyColumns === (reviewPane.clientWidth >= 66 * rootRem ? 2 : 1),
    "Metadata did not adapt to its detail width and computed text size"
  )
  check(
    document
      .querySelector('[aria-label="Pull request description"]')
      ?.textContent?.includes("Preserve unsent drafts"),
    "Overview description is not open"
  )
  check(
    document
      .querySelector('[aria-label="Pull request checks"]')
      ?.textContent?.includes("Desktop checks"),
    "Overview checks missing"
  )
  write("review-page-24", "Draft summary retained across views")
  if (inbox.clientWidth < 60 * rootRem) {
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
    (document.getElementById("review-page-24") as HTMLTextAreaElement).value ===
      "Draft summary retained across views",
    "Selecting a PR discarded its draft"
  )
  const originalTitle = detail.pull_request.title
  detail.pull_request.title =
    "Preserve review drafts and exact inline comment anchors when GitHub rejects a request while a reviewer keeps typing in another conversation pane"
  await click("Refresh pull request")
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
  await click("Refresh pull request")
  const resetScroll = () =>
    document
      .querySelectorAll<HTMLElement>("[data-pr-scroll]")
      .forEach((element) => {
        element.scrollTop = 0
      })
  resetScroll()
  await screenshot("pr-overview")
  await click("Changes")
  await waitFor(
    () => !!document.querySelector("[data-pr-diff]"),
    "Changes did not lazily load its selected diff"
  )
  check(
    document.querySelectorAll("tr").length <= 610,
    "Large diff exceeded initial line budget"
  )
  check(
    document.querySelectorAll('[aria-label="Changed files"] button').length ===
      30,
    "File page lost items"
  )
  check(
    document.querySelectorAll("[data-pr-diff]").length === 1,
    "More than the selected file is mounted"
  )
  resetScroll()
  await screenshot("pr-changes")
  await click("Comment on new line 7")
  write("inline-page-24", "Preserve this inline draft")
  await click("Save inline draft")
  check(
    useReviews.getState().entries[key].draft.inline[0]?.side === "RIGHT",
    "Inline draft lost its line side"
  )
  await click("Conversation")
  await waitFor(
    () =>
      !!reviewRoot().querySelector('[aria-label="Select finding by reviewer"]'),
    "Conversation did not load"
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
    "Conversation source IDs collided or selection disappeared"
  )
  await click("Next page")
  check(
    useReviews.getState().entries[key].page?.page === 2,
    "Conversation pagination did not advance"
  )
  check(
    useReviews.getState().entries[key].draft.selected.length === 3,
    "Paging discarded selected findings"
  )
  check(
    !document.querySelector("[data-pr-diff]"),
    "Conversation retained an offscreen diff"
  )
  resetScroll()
  await screenshot("pr-conversation")
  flushSync(() =>
    useStore.getState().set({ rightTab: "review", rightOpen: true })
  )
  await sleep(180)
  check(
    (document.getElementById("review-dock-24") as HTMLTextAreaElement).value ===
      "Draft summary retained across views",
    "Page and dock lost their shared summary"
  )
  check(
    reviewRoot().textContent?.includes("Preserve this inline draft"),
    "Dock lost saved inline draft"
  )
  resetScroll()
  await screenshot("pr-context-dock")
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
  reviewFixture.failSubmit = true
  await click("Post comment and 1 inline draft")
  check(
    document.querySelector('[role="alert"]'),
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
  await sleep(400)
  check(
    useReviews.getState().entries[key].draft.body === "Keep this newer draft",
    "Slow submission erased new typing"
  )
  check(
    !useReviews.getState().entries[key].draft.inline.length,
    "Successful post did not remove submitted inline draft"
  )
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
    document.activeElement?.textContent === "Conversation",
    "End did not focus Conversation"
  )
  check(
    useReviews.getState().entries[key].workspace === "conversation",
    "Keyboard did not select Conversation"
  )
  tabs[2].dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true })
  )
  await sleep(100)
  check(
    useReviews.getState().entries[key].workspace === "overview",
    "Home did not return to Overview"
  )
  if (stress === "rtl") {
    tabs[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
    )
    await sleep(100)
    check(
      document.activeElement?.textContent === "Conversation",
      "RTL ArrowRight did not move toward the previous tab"
    )
    tabs[2].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
    )
    await sleep(100)
    check(
      document.activeElement?.textContent === "Overview",
      "RTL ArrowLeft did not move toward the next tab"
    )
  }
  await click("View all check pages")
  check(
    reviewRoot().textContent?.includes("Check 1.0"),
    "Complete check page missing"
  )
  await click("Next page")
  check(
    useReviews.getState().entries[key].page?.page === 2,
    "Checks pagination did not advance"
  )
  await click("Changes")
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
  await screenshot("pr-dock-changes")
  await click("Overview")
  const bodyBeforeNewHead = useReviews.getState().entries[key].draft.body
  const pageCallsBeforeNewHead = reviewFixture.calls.filter(
    (call) => call.method === "github.pr.page" && call.params.kind === "files"
  ).length
  detail.head_sha = "reviewed-head-updated"
  await click("Refresh pull request")
  check(
    useReviews.getState().entries[key].page === null,
    "Overview refresh retained a diff from the prior head"
  )
  await click("Changes")
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
    reviewRoot().textContent?.includes("This draft refers to"),
    "Changed head did not warn about stale draft"
  )
  check(
    (button("Post comment") as HTMLButtonElement).disabled,
    "Stale summary remained publishable"
  )
  await click("Use draft text for current commit")
  check(
    useReviews.getState().entries[key].draft.sourceHead === detail.head_sha,
    "Explicit draft reuse did not bind current commit"
  )
  for (const action of [
    "Merge pull request",
    "Close pull request",
    "Approve",
  ]) {
    await click("Review actions")
    await click(action)
    check(
      document
        .querySelector('[role="dialog"]')
        ?.textContent?.includes(`${action}?`),
      `${action} skipped explicit confirmation`
    )
    await click("Cancel")
  }
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
  await click("Send to agent")
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
