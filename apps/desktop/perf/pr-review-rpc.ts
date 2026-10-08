/* eslint-disable @typescript-eslint/no-explicit-any */
import { useStore } from "../src/state/store"
import type {
  PrActionParams,
  PrDetailResult,
  PrPageResult,
  UserMessage,
} from "../src/protocol"
export * from "../src/state/rpc"

export const reviewFixture = {
  /** Make every list call fail the way the daemon reports a missing or signed-out gh. */
  ghError: null as null | "missing" | "auth" | "other",
  /** Hold list responses, so the loading skeleton can be captured. */
  listDelay: 0,
  failSubmit: false,
  slowSubmit: false,
  calls: [] as { method: string; params: any }[],
  sent: [] as { threadId: string; message: UserMessage }[],
  checkedOut: null as {
    threadId: string
    headSha: string
    branch: string
  } | null,
  repairSteps: [] as {
    kind: "checkout" | "send"
    threadId: string
    headSha: string
  }[],
}
// A tiny inline avatar, so no fixture ever touches the network.
const avatar = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${hue} 55% 55%)"/></svg>`)}`
export const detail: PrDetailResult = {
  pull_request: {
    number: 24,
    title: "Preserve review drafts when GitHub rejects a request",
    url: "https://github.com/example/repository/pull/24",
    state: "OPEN",
    head: "feature/review",
    base: "main",
    is_draft: false,
    author: "contributor",
    updated_at: "2026-10-08T00:00:00Z",
    created_at: "2026-10-05T00:00:00Z",
    author_avatar_url: avatar(210),
    additions: 1284,
    deletions: 612,
    review_decision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    labels: [
      { name: "design", color: "a371f7" },
      { name: "desktop", color: "1a7f37" },
    ],
    checks_summary: { total: 100, passed: 98, failed: 1, pending: 1, skipped: 0 },
  },
  body: "Review the failure path before merging.\n\n- Preserve **unsent drafts**.\n- Keep the selected line on the correct side.\n\n```ts\nconst keepDraft = true\n```",
  head_sha: "reviewed-head",
  reviewers: ["reviewer"],
  // 100 checks: one failing, one running, the rest passed. The first passing
  // one is named so the summary assertions can find it among the top rows.
  checks: Array.from({ length: 100 }, (_, index) => ({
    name: index === 0 ? "Desktop checks" : index === 1 ? "Rust (macos-latest)" : `Check ${index}`,
    status: index === 2 ? "IN_PROGRESS" : "COMPLETED",
    conclusion: index === 2 ? "" : index === 1 ? "FAILURE" : "SUCCESS",
    url: "https://github.com/example/repository/actions/1",
  })),
  changed_files: 75,
  merge_state_status: "BLOCKED",
  reviews: [
    { login: "reviewer", state: "CHANGES_REQUESTED", avatar_url: avatar(20) },
    { login: "maintainer", state: "REQUESTED", avatar_url: avatar(120) },
  ],
  comment_count: 4,
}
const base = detail.pull_request
const listed = [
  { ...base },
  {
    ...base,
    number: 25,
    title: "Improve reviewer keyboard navigation",
    head: "feature/review-keyboard",
    updated_at: "2026-10-07T20:00:00Z",
    additions: 96,
    deletions: 31,
    author_avatar_url: avatar(300),
    checks_summary: { total: 5, passed: 3, failed: 0, pending: 2, skipped: 0 },
  },
  {
    ...base,
    number: 26,
    title: "Fit remote https chips to the daemon frame",
    head: "feature/chips",
    updated_at: "2026-10-07T10:00:00Z",
    additions: 212,
    deletions: 40,
    author: "dependabot",
    author_is_bot: true,
    author_avatar_url: undefined,
    checks_summary: { total: 4, passed: 4, failed: 0, pending: 0, skipped: 0 },
  },
  {
    ...base,
    number: 27,
    title: "Keep tall hosted paragraphs off a leftover paint layer",
    head: "feature/paint",
    updated_at: "2026-10-06T10:00:00Z",
    mergeable: "CONFLICTING",
    additions: 58,
    deletions: 12,
    author_avatar_url: "https://invalid.example/broken.png",
    checks_summary: undefined,
  },
  {
    ...base,
    number: 28,
    title: "Rework the usage rail",
    head: "feature/usage",
    updated_at: "2026-10-05T10:00:00Z",
    is_draft: true,
    additions: 8,
    deletions: 1,
    checks_summary: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 },
  },
  {
    ...base,
    number: 29,
    title: "Ship the motion layer",
    head: "feature/motion",
    state: "MERGED",
    updated_at: "2026-10-04T10:00:00Z",
    additions: 540,
    deletions: 90,
  },
]
const patch = `@@ -1,1 +1,1200 @@\n-old value\n${Array.from({ length: 1200 }, (_, index) => `+new value ${index + 1}`).join("\n")}\n`
async function call(method: string, params: any): Promise<any> {
  reviewFixture.calls.push({ method, params: structuredClone(params) })
  if (method === "github.pr.list") {
    if (reviewFixture.listDelay)
      await new Promise((resolve) => setTimeout(resolve, reviewFixture.listDelay))
    if (reviewFixture.ghError === "missing")
      throw new Error("run gh: No such file or directory (os error 2)")
    if (reviewFixture.ghError === "auth")
      throw new Error("gh pr list: To get started with GitHub CLI, please run: gh auth login")
    if (reviewFixture.ghError === "other") throw new Error("gh pr list: rate limited")
    const want = params.state as string
    return {
      pull_requests: listed
        .filter((pr) => (want === "all" ? true : pr.state.toLowerCase() === want))
        // The first row follows the live `detail`, which tests edit.
        .map((pr) => (pr.number === 24 ? { ...pr, ...detail.pull_request } : pr)),
    }
  }
  if (method === "github.pr.detail")
    return params.number === 24
      ? structuredClone(detail)
      : {
          ...detail,
          head_sha: `reviewed-${params.number}-head`,
          pull_request: listed.find((pr) => pr.number === params.number) ?? {
            ...detail.pull_request,
            number: params.number,
          },
        }
  if (method === "github.pr.page") {
    const page: PrPageResult = {
      files: [],
      entries: [],
      checks: [],
      page: params.page ?? 1,
      has_more: (params.page ?? 1) < 3,
    }
    if (params.kind === "files")
      page.files = Array.from({ length: 30 }, (_, index) => ({
        path:
          page.page === 1 && index === 0
            ? detail.head_sha === "reviewed-head"
              ? "src/reviews/submission.ts"
              : "src/reviews/submission-updated.ts"
            : `src/reviews/validation-${page.page}-${index}.ts`,
        old_path: null,
        status: "modified",
        additions: 1200,
        deletions: 1,
        patch,
        patch_truncated: false,
      }))
    else if (params.kind === "checks")
      page.checks = Array.from({ length: 30 }, (_, index) => ({
        name: `Check ${page.page}.${index}`,
        status: "COMPLETED",
        conclusion: index ? "SUCCESS" : "FAILURE",
        url: "https://github.com/example/repository/actions/1",
      }))
    else
      page.entries = [
        {
          id: 1,
          author: "reviewer",
          body: "Handle the rejected request and **keep the local draft**.\n\n`source.ts:7` must remain reachable.",
          state: params.kind === "reviews" ? "CHANGES_REQUESTED" : "",
          path:
            params.kind === "review_comments"
              ? "src/reviews/submission.ts"
              : null,
          line: 7,
          side: "RIGHT",
          url: detail.pull_request.url,
          updated_at: "2026-10-08",
        },
      ]
    return page
  }
  if (method === "github.pr.action") {
    const action = params as PrActionParams
    if (action.action === "checkout") {
      const thread =
        action.thread_id && useStore.getState().threads[action.thread_id]
      if (
        action.project_id !== "project" ||
        action.number !== detail.pull_request.number ||
        action.head_sha !== detail.head_sha ||
        !thread?.worktree
      )
        throw new Error(
          "Cannot check out an unverified review head or unmanaged conversation."
        )
      await new Promise((resolve) => setTimeout(resolve, 180))
      reviewFixture.checkedOut = {
        threadId: thread.id,
        headSha: action.head_sha,
        branch: detail.pull_request.head,
      }
      reviewFixture.repairSteps.push({
        kind: "checkout",
        ...reviewFixture.checkedOut,
      })
      // Checkout returns Empty on the wire; its observable effect is a verified
      // managed worktree. Publication failure/latency controls do not apply here.
      return {}
    }
    if (["comment", "approve", "request_changes"].includes(action.action)) {
      if (reviewFixture.slowSubmit)
        await new Promise((resolve) => setTimeout(resolve, 300))
      if (reviewFixture.failSubmit)
        throw new Error("GitHub unavailable. Try again.")
    }
    return {}
  }
  if (method === "git.status") return useStore.getState().gitStatuses.repair
  if (method === "threads.worktree.inspect")
    return {
      path: "/scratch/managed/repair",
      branch: "feature/review",
      exists: true,
      clean: false,
      merged: false,
      ignored_files: 0,
      blockers: [],
      eligible: false,
    }
  if (method === "threads.worktree.remove")
    return {
      path: "/scratch/managed/repair",
      branch: "feature/review",
      exists: false,
      clean: false,
      merged: false,
      ignored_files: 0,
      blockers: [],
      eligible: false,
    }
  throw new Error(`Unexpected review fixture request: ${method}`)
}
const client = { call }
export function rpc() {
  return client
}
export async function loadGitStatus() {}
export function activeRuntime() {
  return {
    rpc,
    loadGitStatus,
    createThread: async () => "repair",
    sendMessage: async (threadId: string, message: UserMessage) => {
      const checkedOut = reviewFixture.checkedOut
      if (
        checkedOut?.threadId !== threadId ||
        checkedOut.headSha !== detail.head_sha ||
        checkedOut.branch !== detail.pull_request.head
      )
        throw new Error(
          "Repair must check out the reviewed head before sending."
        )
      reviewFixture.repairSteps.push({ kind: "send", ...checkedOut })
      reviewFixture.sent.push({ threadId, message })
    },
  }
}
