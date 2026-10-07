import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThemeProviderContext } from "../src/components/theme-context"
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
} from "../src/lib/kit/theme/theme.logic"
import { PrReview, PrReviewDock } from "../src/views/PrReview"
import { WorktreeCleanupDialog } from "../src/views/WorktreeCleanup"
import { useReviews, reviewKey, updateReviewDraft } from "../src/state/prReview"
import { useStore } from "../src/state/store"
import type { Settings, Thread } from "../src/protocol"
import { detail, reviewFixture } from "./pr-review-rpc"
import "../src/index.css"

declare const __ORCH_THEME__: "light" | "dark"
const theme = __ORCH_THEME__
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
  await new Promise<void>((resolve) => {
    ;(
      window as unknown as { __screenshotContinue: () => void }
    ).__screenshotContinue = resolve
    post({ screenshot: `${name}-${theme}-${innerWidth}` })
  })
}
export function Shell() {
  const dock = useStore((state) => state.rightTab === "review")
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
        {dock ? (
          <PrReviewDock threadId="repair" active />
        ) : (
          <PrReview projectId="project" number={24} onBack={() => {}} />
        )}
        <WorktreeCleanupDialog />
      </main>
    </ThemeProviderContext>
  )
}
const visible = (element: HTMLElement) =>
  element.getClientRects().length > 0 &&
  !element.closest('[aria-hidden="true"]')
function button(label: string) {
  const element = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="menuitem"]')
  ).find(
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
  const textarea = document.getElementById(id) as HTMLTextAreaElement
  check(textarea, `Missing input ${id}`)
  textarea.focus()
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
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
  await sleep(450)
  check(
    document.querySelectorAll("tr").length <= 610,
    "Large diff mounted more than the initial line budget"
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
  write("review-page-24", "Draft summary retained across views")
  await click("Comment on new line 7")
  write("inline-24", "Preserve this inline draft")
  await click("Save inline draft")
  check(
    useReviews.getState().entries[key].draft.inline.length === 1,
    "Inline draft was not saved"
  )
  const scroller = Array.from(
    document.querySelectorAll<HTMLElement>(".overflow-auto")
  ).find(
    (element) =>
      element.clientHeight > 250 && element.scrollHeight > element.clientHeight
  )
  if (scroller) scroller.scrollTop = 0
  await screenshot("pr-full")
  flushSync(() => useStore.getState().set({ rightTab: "review" }))
  await sleep(180)
  check(
    (document.getElementById("review-dock-24") as HTMLTextAreaElement).value ===
      "Draft summary retained across views",
    "Full page and dock lost shared summary"
  )
  check(
    document.body.textContent?.includes("Preserve this inline draft"),
    "Dock lost saved inline draft"
  )
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
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  )
  tabs[0].focus()
  tabs[0].dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true })
  )
  await sleep(160)
  check(
    document.activeElement?.textContent === "Checks",
    "End did not move keyboard focus to Checks"
  )
  check(
    useReviews.getState().entries[key].kind === "checks",
    "Keyboard focus did not select the check page"
  )
  check(document.body.textContent?.includes("Check 1.0"), "Check page missing")
  tabs[4].dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true })
  )
  await sleep(160)
  check(
    useReviews.getState().entries[key].kind === "files",
    "Home did not return to Files"
  )
  await click("Next page")
  check(
    useReviews.getState().entries[key].page?.page === 2,
    "File paging did not advance"
  )
  check(
    document.querySelectorAll("tr").length <= 610,
    "Paging mounted cumulative diffs"
  )
  const dockScroller = Array.from(
    document.querySelectorAll<HTMLElement>(".overflow-auto")
  ).find(
    (element) =>
      element.clientHeight > 250 && element.scrollHeight > element.clientHeight
  )
  if (dockScroller) dockScroller.scrollTop = 0
  await screenshot("pr-dock")
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
        path: "src/review-1-0.ts",
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
    JSON.stringify(reviewFixture.sent[0].message).includes("reviewed-head"),
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
    width: innerWidth,
    mountedDiffRows: document.querySelectorAll("tr").length,
    sharedDrafts: true,
    retainedFailureDrafts: true,
    keyboardChecks: true,
    cleanupConfirmation: true,
    checkoutForRepair: true,
    explicitRepair: true,
  })
}
run().catch((error) =>
  post({ pass: false, fixture: "pr-review", error: String(error) })
)
