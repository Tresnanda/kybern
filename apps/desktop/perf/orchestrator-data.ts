// Synthetic Orchestrator V2 state: a thread that delegated to agents of every kind, the messages
// they exchanged, and the held messages that wait for the reader. No daemon, no provider.
import type { AgentResultItem, DelegationInfo, Project, ProviderStatus, Thread, ThreadMessageRecord } from "../src/protocol"
import type { Block } from "../../../packages/kybern-client/src/transcript"

const base = Date.now()
export const ago = (seconds: number) => new Date(base - seconds * 1000).toISOString()

export const projects: Record<string, Project> = {
  "project-0": { id: "project-0", name: "Kybern", path: "/project", is_git: true, created_at: ago(9000), updated_at: ago(9000) },
}

export const providers: ProviderStatus[] = [
  ["claude-code", "Claude Code", "claude-opus-4-5", "Claude Opus 4.5"],
  ["codex", "Codex", "gpt-5.6-sol", "GPT-5.6 Sol"],
  ["cursor", "Cursor", "auto", "Auto"],
  ["opencode", "OpenCode", "default", "Default model"],
  ["pi", "Pi", "default", "Default model"],
  ["omp", "Oh My Pi", "default", "Default model"],
].map(([kind, display_name, id, name]) => ({
  kind, display_name, available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"],
  models: [{ id, display_name: name, is_default: true }],
})) as ProviderStatus[]

const thread = (id: string, title: string, extra: Partial<Thread> = {}): Thread => ({
  id, title, project_id: "project-0", provider: { kind: "claude-code", instance: "default" }, model: "claude-opus-4-5", permission_mode: "supervised",
  status: "idle", cwd: "/project", pinned: false, created_at: ago(900), updated_at: ago(60), last_seq: 0, ...extra,
})

const info = (extra: Partial<DelegationInfo> & Pick<DelegationInfo, "task_id" | "status" | "role" | "workspace">): DelegationInfo => ({
  operation_id: `op-${extra.task_id}`, parent_thread_id: "main", depth: 1, owns: [], files_touched: [], conflicts: [], started_at: ago(300), ...extra,
})

export const sessionResult = [
  "Wired the session store into the sign-in flow.",
  "",
  "- `useSession()` now reads from `src/auth/session.ts` and refreshes tokens five minutes before they expire.",
  "- Signing out clears the store and the cookie in one step.",
  "- The sign-in form redirects to the page you came from after a successful sign-in.",
  "- Added six tests for refresh, expiry and sign-out.",
  "- Removed the unused `legacySession` helper and its two call sites.",
  "",
  "Left for you to decide: the store keeps tokens in memory only, so a reload signs the user out. Say if you want them persisted.",
  "",
  "Merge `kybern/9c1e47b2` when you are ready.",
].join("\n")

export const threads: Record<string, Thread> = {
  main: thread("main", "Ship the new sign-in flow", { status: "idle" }),
  "c-form": thread("c-form", "Build the sign-in form", {
    parent_thread_id: "main", provider: { kind: "codex", instance: "default" }, model: "gpt-5.6-sol", status: "running", created_at: ago(94),
    delegation: info({ task_id: "t-form", status: "running", role: "implementation", workspace: "shared", owns: ["src/auth/SignInForm.tsx", "src/auth/forms/**"], started_at: ago(94),
      files_touched: ["src/auth/SignInForm.tsx", "src/auth/forms/Field.tsx", "src/auth/forms/useSignInForm.ts", "src/auth/session.ts", "src/styles/auth.css"],
      conflicts: [{ path: "src/auth/session.ts", owner_thread_id: "c-session", at: ago(31) }] }),
  }),
  "g-review": thread("g-review", "Check the form for accessibility issues", {
    parent_thread_id: "c-form", provider: { kind: "pi", instance: "default" }, model: null, status: "awaiting-approval", created_at: ago(40),
    delegation: info({ task_id: "t-review", status: "running", role: "review", workspace: "shared", depth: 2, parent_thread_id: "c-form", started_at: ago(40) }),
  }),
  "c-session": thread("c-session", "Wire up the session store", {
    parent_thread_id: "main", status: "idle", created_at: ago(300), worktree: { path: "/worktrees/c-session", branch: "kybern/9c1e47b2-0c4e-4f55-9d0a-6a1d5e6f7a10" },
    delegation: info({ task_id: "t-session", status: "completed", role: "implementation", workspace: "worktree", started_at: ago(300), completed_at: ago(118), result: sessionResult,
      files_touched: ["src/auth/session.ts", "src/auth/useSession.ts", "src/auth/session.test.ts"], base_commit: "4be71c05a9", head_commit: "e90a1d3f72", branch: "kybern/9c1e47b2-0c4e-4f55-9d0a-6a1d5e6f7a10",
      diffstat: { files: 3, additions: 128, deletions: 14 }, worktree_state: "active" }),
  }),
  "c-kept": thread("c-kept", "Migrate the user table", {
    parent_thread_id: "main", provider: { kind: "cursor", instance: "default" }, model: "auto", status: "idle", created_at: ago(300), worktree: { path: "/worktrees/c-kept", branch: "kybern/b7d2a3c4-1d51-4a26-8c3e-4f9a0b2c1d77" },
    delegation: info({ task_id: "t-kept", status: "completed", role: "implementation", workspace: "worktree", started_at: ago(300), completed_at: ago(205),
      result: "Added the `0012_add_sign_in_method` migration and a backfill for existing rows.\n\nThe backfill needs a production snapshot to test against, so I stopped before running it.",
      files_touched: ["db/migrations/0012_add_sign_in_method.sql", "db/backfill/sign_in_method.ts"], base_commit: "4be71c05a9", head_commit: "2a6f8d9c01", branch: "kybern/b7d2a3c4-1d51-4a26-8c3e-4f9a0b2c1d77",
      diffstat: { files: 2, additions: 46, deletions: 3 }, worktree_state: "kept" }),
  }),
  "c-fail": thread("c-fail", "Write the end-to-end test", {
    parent_thread_id: "main", provider: { kind: "opencode", instance: "default" }, model: null, status: "failed", created_at: ago(300),
    delegation: info({ task_id: "t-fail", status: "failed", role: "test", workspace: "shared", started_at: ago(300), completed_at: ago(160), error: "Playwright could not start: port 4173 is already in use.",
      result: "Wrote `e2e/sign-in.spec.ts`; it has not run yet.", files_touched: ["e2e/sign-in.spec.ts"] }),
  }),
  "c-review": thread("c-review", "Review the session store changes", {
    parent_thread_id: "main", status: "running", created_at: ago(22),
    delegation: info({ task_id: "t-rev", status: "running", role: "review", workspace: "shared", started_at: ago(22) }),
  }),
  "n-explore": thread("n-explore", "Explore the auth module", {
    parent_thread_id: "main", status: "idle", created_at: ago(500),
    subagent: { task_id: "sub-1", root_thread_id: "main", parent_turn_id: "turn-1", agent_type: "Explore", status: "completed", started_at: ago(500), completed_at: ago(470),
      result: "The auth module has three entry points: `signIn`, `signOut` and `refresh`. Only `refresh` touches the cookie." } as Thread["subagent"],
  }),
  "h-legacy": thread("h-legacy", "Research OAuth providers", { parent_thread_id: "main", status: "idle", created_at: ago(800), provider: { kind: "codex", instance: "default" }, model: "gpt-5.6-sol" }),
}

// ---- transcript of the delegating thread ----

const at = (s: number) => ago(s)
const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
let seq = 1
const delegateCall = (id: string, turnId: string, input: Record<string, unknown>, result: Record<string, unknown>, s: number): Block => ({
  kind: "tool", id: `tool:${id}`, turnId, at: at(s), seq: seq++, origin: { kind: "root" }, call: { id, name: "mcp__kybern__kybern_agent_delegate", input }, stream: "", isError: false, complete: true,
  output: { content: [{ type: "text", text: JSON.stringify(result) }] },
})
const sendCall = (id: string, turnId: string, input: Record<string, unknown>, result: Record<string, unknown> | null, s: number): Block => ({
  kind: "tool", id: `tool:${id}`, turnId, at: at(s), seq: seq++, origin: { kind: "root" }, call: { id, name: "mcp__kybern__kybern_thread_send", input }, stream: "", isError: false, complete: true,
  output: { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] },
})
const assistant = (id: string, turnId: string, text: string, s: number): Block => ({ kind: "assistant", id: `${id}#0`, messageId: id, segment: 0, turnId, at: at(s), seq: seq++, origin: { kind: "root" }, text, thinking: "", complete: true })
const user = (id: string, turnId: string, parts: unknown[], s: number): Block => ({ kind: "user", id, turnId, at: at(s), seq: seq++, message: { parts } as never })
const end = (id: string, turnId: string, s: number, duration: number): Block => ({ kind: "turn_end", id, turnId, at: at(s), seq: seq++, stopReason: "completed", usage, costUsd: null, durationMs: duration, terminalMessageId: null, error: null })

const launch = (id: string, child: Thread, task: string, extra: Record<string, unknown>, s: number, turnId = "turn-1") =>
  delegateCall(id, turnId, { task, title: child.title, role: child.delegation!.role, workspace: child.delegation!.workspace, provider: child.provider.kind, ...extra }, {
    task_id: child.delegation!.task_id, thread_id: child.id, title: child.title, provider: child.provider.kind, model: child.model, workspace: child.delegation!.workspace, branch: child.delegation!.branch ?? null, status: "running",
  }, s)

export const resultItems: AgentResultItem[] = (["c-session", "c-kept", "c-fail"] as const).map((id) => {
  const child = threads[id]!
  const d = child.delegation!
  return { task_id: d.task_id, thread_id: id, title: child.title, provider: child.provider.kind, model: child.model, role: d.role, status: d.status, result: d.result ?? null, error: d.error ?? null,
    workspace: d.workspace, branch: d.branch ?? null, head_commit: d.head_commit ?? null, diffstat: d.diffstat ?? null, files_touched: d.files_touched, conflicts: d.conflicts }
})

export const mainBlocks: Block[] = [
  user("u1", "turn-1", [{ type: "text", text: "Ship the new sign-in flow. Split it up: one agent builds the form, one wires the session store in its own worktree, one migrates the user table in its own worktree, and one writes the end-to-end test. Check back with me when they are done." }], 640),
  assistant("a1", "turn-1", "I’ll start four agents. The form agent works in this checkout and owns `src/auth/forms`; the session store and the migration each get their own worktree so they cannot collide with it. I’ll wait for their results.", 630),
  launch("d1", threads["c-form"]!, "Build the sign-in form in src/auth/SignInForm.tsx using the existing Field component.", { owns: ["src/auth/forms/**"] }, 620),
  launch("d2", threads["c-session"]!, "Wire the session store into the sign-in flow. Commit on your branch.", {}, 619),
  launch("d3", threads["c-kept"]!, "Add the sign_in_method column and a backfill.", {}, 618),
  launch("d4", threads["c-fail"]!, "Write an end-to-end test for sign-in with Playwright.", {}, 617),
  assistant("a2", "turn-1", "All four are running. I’ll end my turn; their results arrive here together.", 610),
  end("e1", "turn-1", 600, 40000),
  user("u2", "turn-2", [{ type: "agent_results", items: resultItems }], 118),
  assistant("a3", "turn-2", "The session store and the migration are done, each in its own worktree. The end-to-end test failed to start because port 4173 is taken. I’ll ask the form agent how it handles errors, tell the reviewer what changed, and keep the failed test for later.", 110),
  sendCall("s1", "turn-2", { thread_id: "c-form", purpose: "question", body: "How does the form report a failed sign-in? I want the session store’s error to show up in the same place.", wait_for_reply: true }, {
    message_id: "m-1", state: "answered", delivered_as: "queued", reply: { message_id: "m-1r", from_thread_id: "c-form", body: "It sets `formError` on the form state and renders it above the submit button. Pass the store’s error to `setFormError`." },
  }, 100),
  sendCall("s2", "turn-2", { thread_id: "c-review", purpose: "message", delivery: "steer", body: "The session store keeps tokens in memory only. Please check that sign-out clears them." }, { message_id: "m-2", state: "steered", delivered_as: "steered" }, 90),
  sendCall("s3", "turn-2", { thread_id: "c-fail", purpose: "task", body: "Retry the end-to-end test on port 4180. The dev server is on 4173." }, { message_id: "m-3", state: "held", delivered_as: "held" }, 80),
  launch("d5", threads["c-review"]!, "Review the session store changes on branch kybern/9c1e47b2.", {}, 70, "turn-2"),
  assistant("a4", "turn-2", "I sent the retry to the test agent, but it needs your approval first. The reviewer is checking the session store now.", 60),
  end("e2", "turn-2", 55, 60000),
]

// ---- transcript of the form agent: every kind of inbound message ----

const brief = "You are a delegated implementation agent working for thread \"Ship the new sign-in flow\".\nYou share the parent's checkout and branch. Do not commit, stash, reset, checkout, rebase or switch branches; the parent integrates.\nYou own: src/auth/SignInForm.tsx, src/auth/forms/**. Avoid editing other paths; other agents may own them.\nYour final message is returned to the parent as your result, so end with a concise summary of what you did, what changed, and anything unresolved.\n\nTask:\nBuild the sign-in form in src/auth/SignInForm.tsx using the existing Field component. It needs an email field, a password field with a show/hide toggle, inline validation and a disabled submit button while the request is in flight."
const part = (extra: Record<string, unknown>) => ({ type: "thread_message", from_title: "", ...extra })
export const formBlocks: Block[] = [
  user("f1", "ft-1", [part({ message_id: "fm-1", from_thread_id: "main", from_title: "Ship the new sign-in flow", purpose: "task", body: brief })], 92),
  assistant("fa1", "ft-1", "Reading the Field component first. I need one decision before I wire the error messages.", 88),
  sendCall("fs1", "ft-1", { thread_id: "main", purpose: "question", body: "Should the form announce an error when a field loses focus, or only on submit?" }, { message_id: "mq-1", state: "queued", delivered_as: "queued" }, 84),
  end("fe1", "ft-1", 80, 12000),
  user("f2", "ft-2", [part({ message_id: "fm-2", from_thread_id: "g-review", from_title: "Check the form for accessibility issues", purpose: "question", body: "Is the show/hide toggle reachable with the keyboard? I could not focus it with Tab." })], 60),
  assistant("fa2", "ft-2", "It is a plain `button`, so it should be. I’ll check the tab order.", 56),
  end("fe2", "ft-2", 52, 8000),
  user("f3", "ft-3", [part({ message_id: "fm-3", from_thread_id: "main", from_title: "Ship the new sign-in flow", purpose: "reply", reply_to: "mq-1", body: "On blur, and again on submit. Use `aria-live=\"polite\"` so it does not interrupt typing." })], 44),
  assistant("fa3", "ft-3", "Announcing on blur and on submit with a polite live region.", 40),
  end("fe3", "ft-3", 36, 6000),
  user("f4", "ft-4", [part({ message_id: "fm-4", from_thread_id: null, from_title: "Kybern", purpose: "warning", body: "\"src/auth/session.ts\" is owned by \"Wire up the session store\". Stop editing it and tell your parent if you need that change." })], 31),
  assistant("fa4", "ft-4", "I’ll leave `session.ts` alone and note what I need from it in my summary.", 28),
  user("f5", "ft-4", [part({ message_id: "fm-5", from_thread_id: "main", from_title: "Ship the new sign-in flow", purpose: "message", body: "Heads up: the design tokens changed. Use `--color-text-danger` for error text." })], 20),
]

export const held: ThreadMessageRecord[] = [
  { id: "h-1", operation_id: "ho-1", from_thread_id: "c-review", to_thread_id: "c-form", purpose: "question", body: "The submit button stays enabled while the request is in flight. Is that intended, or should it be disabled until the response arrives?", delivery: "steer", state: "held", held_reason: "Review the form has broader permissions than this thread.", created_at: ago(18), updated_at: ago(18) },
  { id: "h-2", operation_id: "ho-2", from_thread_id: "c-session", to_thread_id: "c-form", purpose: "message", body: "The session store now exports `useSession`. Import it from `src/auth/useSession` instead of reading the cookie.", delivery: "queue", state: "held", held_reason: null, created_at: ago(9), updated_at: ago(9) },
]
