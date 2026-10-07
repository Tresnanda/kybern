/* eslint-disable @typescript-eslint/no-explicit-any */
import { useStore } from "../src/state/store"
import type { PrDetailResult, PrPageResult, UserMessage } from "../src/protocol"
export * from "../src/state/rpc"

export const reviewFixture = {
  failSubmit: false,
  slowSubmit: false,
  calls: [] as { method: string; params: any }[],
  sent: [] as { threadId: string; message: UserMessage }[],
}
export const detail: PrDetailResult = {
  pull_request: {
    number: 24,
    title:
      "Preserve a long, readable review title while sharing drafts between the full page and the conversation dock",
    url: "https://github.com/example/repository/pull/24",
    state: "OPEN",
    head: "feature/review",
    base: "main",
    is_draft: false,
    author: "contributor",
    updated_at: "2026-10-08T00:00:00Z",
  },
  body: "Review the failure path before merging.\n\n- Preserve **unsent drafts**.\n- Keep the selected line on the correct side.\n\n```ts\nconst keepDraft = true\n```",
  head_sha: "reviewed-head",
  reviewers: ["reviewer"],
  checks: [
    {
      name: "Desktop checks",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      url: "https://github.com/example/repository/actions/1",
    },
  ],
  changed_files: 75,
}
const patch = `@@ -1,1 +1,1200 @@\n-old value\n${Array.from({ length: 1200 }, (_, index) => `+new value ${index + 1}`).join("\n")}\n`
async function call(method: string, params: any): Promise<any> {
  reviewFixture.calls.push({ method, params: structuredClone(params) })
  if (method === "github.pr.detail") return detail
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
        path: `src/review-${page.page}-${index}.ts`,
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
          path: params.kind === "review_comments" ? "src/review-1-0.ts" : null,
          line: 7,
          side: "RIGHT",
          url: detail.pull_request.url,
          updated_at: "2026-10-08",
        },
      ]
    return page
  }
  if (method === "github.pr.action") {
    if (reviewFixture.slowSubmit)
      await new Promise((resolve) => setTimeout(resolve, 300))
    if (reviewFixture.failSubmit)
      throw new Error("GitHub unavailable. Try again.")
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
      reviewFixture.sent.push({ threadId, message })
    },
  }
}
