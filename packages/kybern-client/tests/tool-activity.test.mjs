import assert from "node:assert/strict"
import test from "node:test"

import { isImageGenerationTool, humanizeToolName, isAgentLaunchTool, runtimeActivityPrompt, runtimeActivityResult, summarizeToolCalls, toolLine, toolLineCounts, toolSummaryPhrases, toolTarget, toolVisualKind } from "../src/toolActivity.ts"

const call = (name, input) => ({ id: "tool-1", name, input })
const cua = (code, title) => call("mcp:cua_repl/js", { code, title })

test("Claude read calls use live and settled tense", () => {
  const read = call("Read", { file_path: "/workspace/docs/RTK.md" })
  assert.deepEqual(toolLine(read, false), {
    verb: "Reading",
    detail: "…/docs/RTK.md",
    mono: true,
    kind: "read",
  })
  assert.deepEqual(toolLine(read, true), {
    verb: "Read",
    detail: "…/docs/RTK.md",
    mono: true,
    kind: "read",
  })
})

test("Codex command actions take precedence over shell wrappers", () => {
  const read = call("shell", {
    command: `/bin/zsh -lc "sed -n '1,220p' RTK.md"`,
    actions: [
      {
        type: "read",
        command: "sed -n '1,220p' RTK.md",
        name: "RTK.md",
        path: "/workspace/RTK.md",
      },
    ],
  })
  assert.deepEqual(toolLine(read, false), {
    verb: "Reading",
    detail: "RTK.md",
    mono: true,
    kind: "read",
  })
})

test("Codex shell reads are inferred when command actions are unavailable", () => {
  const read = call("shell", {
    command: `/bin/zsh -lc "cd '/workspace' && sed -n '130,210p' apps/desktop/src/views/Transcript.tsx"`,
  })
  assert.deepEqual(toolLine(read, false), {
    verb: "Reading",
    detail: "…/views/Transcript.tsx",
    mono: true,
    kind: "read",
  })

  const livePayload = call("shell", {
    command: `/bin/zsh -lc "sed -n '1,"'$p'"' docs/architecture.md
sleep 20"`,
    actions: [{ type: "unknown", command: "sed -n '1,$p' docs/architecture.md\nsleep 20" }],
  })
  assert.deepEqual(toolLine(livePayload, false), {
    verb: "Reading",
    detail: "docs/architecture.md",
    mono: true,
    kind: "read",
  })
})

test("OpenCode, pi, omp, and Cursor input shapes normalize as file reads", () => {
  const expected = {
    verb: "Reading",
    detail: "…/docs/architecture.md",
    mono: true,
    kind: "read",
  }
  assert.deepEqual(
    toolLine(call("read", { path: "/workspace/docs/architecture.md" }), false),
    expected
  )
  assert.deepEqual(
    toolLine(
      call("read_file", { filePath: "/workspace/docs/architecture.md" }),
      false
    ),
    expected
  )
  assert.deepEqual(
    toolLine(
      call("read", {
        title: "Reading architecture.md",
        raw: { path: "/workspace/docs/architecture.md" },
      }),
      false
    ),
    expected
  )
})

test("work summaries distinguish delegation from work run by the main agent", () => {
  assert.equal(
    summarizeToolCalls([
      {
        call: call("Bash", { command: "cargo test" }),
        complete: true,
        isError: false,
      },
      {
        call: call("Agent", { description: "Inspect harness parity" }),
        complete: true,
        isError: false,
      },
    ])?.label,
    "Ran 1 command · delegated 1 task"
  )
})

test("focused agent navigation distinguishes launches from coordination calls", () => {
  assert.equal(isAgentLaunchTool(call("Agent", { prompt: "Inspect parity" })), true)
  assert.equal(isAgentLaunchTool(call("collaboration.spawn_agent", { task: "Inspect parity" })), true)
  assert.equal(isAgentLaunchTool(call("other", { title: "Task: inspect parity" })), true)
  assert.equal(isAgentLaunchTool(call("send_message_to_agent", { message: "Keep going" })), false)
  assert.equal(isAgentLaunchTool(call("wait_agent", {})), false)
})

test("focused activity keeps the full delegated prompt across provider wrappers", () => {
  const prompt = "Inspect the repository.\n\nRun the tests and report any failures."
  assert.equal(runtimeActivityPrompt(call("Agent", { description: "Test", prompt })), prompt)
  assert.equal(runtimeActivityPrompt(call("task", { raw_input: JSON.stringify({ assignment: prompt }) })), prompt)
  assert.equal(runtimeActivityPrompt(call("execute", { args: { command: "pnpm test\npnpm typecheck" } })), "pnpm test\npnpm typecheck")
})

test("focused activity prefers clean structured results over harness metadata", () => {
  const result = "Verification complete.\n\nAll checks passed."
  assert.equal(
    runtimeActivityResult({
      content: [
        { type: "text", text: result },
        { type: "text", text: "agentId: agent-7 (use SendMessage to continue)\n<usage>tokens: 1200</usage>" },
      ],
      structured: { status: "completed", content: [{ type: "text", text: result }] },
    }),
    result,
  )
  assert.equal(runtimeActivityResult({ content: "OpenCode finished" }), "OpenCode finished")
  assert.equal(runtimeActivityResult({ raw: "Cursor finished" }), "Cursor finished")
  assert.equal(runtimeActivityResult(null, "streamed result"), "streamed result")
})

test("Cursor titles remain useful when ACP marks the tool kind as other", () => {
  assert.deepEqual(
    toolLine(call("other", { title: "Reading RTK.md", raw: {} }), false),
    {
      verb: "Reading",
      detail: "RTK.md",
      mono: true,
      kind: "read",
    }
  )
  assert.deepEqual(
    toolLine(call("execute", { title: "Run cargo tests", raw: "{}" }), false),
    {
      verb: "Running",
      detail: "cargo tests",
      mono: true,
      kind: "command",
    }
  )
  assert.deepEqual(toolLine(call("other", { title: "Inspect workspace" }), false), {
    verb: "Using",
    detail: "Inspect workspace",
    mono: true,
    kind: "other",
  })
})

test("Codex search and list actions produce specific live activity", () => {
  assert.deepEqual(
    toolLine(
      call("shell", {
        actions: [
          {
            type: "search",
            query: "ToolStarted",
            path: "crates/kybern-drivers",
          },
        ],
      }),
      false
    ),
    {
      verb: "Searching",
      detail: "for ToolStarted in crates/kybern-drivers",
      mono: true,
      kind: "search",
    }
  )
  assert.deepEqual(
    toolLine(
      call("shell", { commandActions: [{ type: "list_files", path: "." }] }),
      false
    ),
    {
      verb: "Listing",
      detail: "current directory",
      mono: true,
      kind: "list",
    }
  )
})

test("generic commands retain a useful running label", () => {
  assert.deepEqual(
    toolLine(call("execute", { command: "cargo test --workspace" }), false),
    {
      verb: "Running",
      detail: "cargo test --workspace",
      mono: true,
      kind: "command",
    }
  )
})

test("namespaced tools get recognizable labels and icons", () => {
  const github = call("mcp__codex_apps__github__search_code", { query: "ToolStarted" })
  assert.equal(humanizeToolName(github.name), "GitHub · Search Code")
  assert.equal(toolVisualKind(github), "github")
  assert.deepEqual(toolLine(github, false), {
    verb: "Searching",
    detail: "GitHub for ToolStarted",
    mono: true,
    kind: "search",
  })

  const computer = call("mcp__cua_repl__js", { title: "Open settings" })
  assert.equal(humanizeToolName(computer.name), "Computer use")
  assert.equal(toolVisualKind(computer), "computer")
  assert.deepEqual(toolLine(computer, true), {
    verb: "Used",
    detail: "Computer use — Open settings",
    mono: false,
    kind: "other",
  })
  assert.equal(humanizeToolName("web__run"), "Web search")

  assert.deepEqual(
    toolLine(call("web__run", { search_query: [{ q: "Tauri CORS" }] }), false),
    {
      verb: "Searching",
      detail: "the web for Tauri CORS",
      mono: false,
      kind: "search",
    }
  )
})

test("settled contiguous tools collapse into a plain-language summary", () => {
  const summary = summarizeToolCalls([
    { call: call("Read", { file_path: "src/a.ts" }), complete: true, isError: false },
    { call: call("Read", { file_path: "src/a.ts" }), complete: true, isError: false },
    { call: call("Read", { file_path: "src/b.ts" }), complete: true, isError: false },
    { call: call("bash", { command: "pnpm test" }), complete: true, isError: false },
  ])
  assert.deepEqual(summary, {
    label: "Ran 1 command · read 2 files",
    visual: "read",
    entryCount: 4,
  })
  assert.equal(
    summarizeToolCalls([
      { call: call("Read", { path: "a" }), complete: false, isError: false },
      { call: call("Read", { path: "b" }), complete: true, isError: false },
    ]),
    null
  )
})

test("Codex screen-control calls read as computer use, not browser tools", () => {
  assert.equal(toolVisualKind(cua("await app.getScreenshot();", "Take one screenshot")), "computer")
  assert.equal(humanizeToolName("mcp:cua_repl/js"), "Computer use")
  assert.equal(toolLine(cua("await cua.getState();", "Capture screen state")).detail, "Computer use — Capture screen state")
  const summary = summarizeToolCalls([
    { call: cua("await cua.getState();", "Capture screen state"), complete: true, isError: false },
    { call: cua("await app.getScreenshot();", "Take one screenshot"), complete: true, isError: false },
  ])
  assert.deepEqual(summary, { label: "Used your computer 2 times", visual: "computer", entryCount: 2 })
})

test("image generation stays a deliverable without promoting inspection screenshots", () => {
  for (const name of ["imageGeneration", "image_generation", "image_gen.imagegen", "mcp__images__generate_image"]) assert.equal(isImageGenerationTool({ name }), true, name)
  for (const name of ["imageView", "view_image", "mcp__browser__screenshot", "exec_command"]) assert.equal(isImageGenerationTool({ name }), false, name)
})

test("Kybern notes and tasks tools get their own labels, icons and summary", () => {
  const call = (name, input = {}) => ({ id: name, name, input })
  assert.equal(toolVisualKind(call("mcp__kybern__kybern_task_create")), "task")
  assert.equal(toolVisualKind(call("kybern_note_read")), "note")
  assert.equal(toolLine(call("mcp__kybern__kybern_task_update", { task: "ADE-3" }), false).verb, "Updating task ADE-3")
  assert.equal(humanizeToolName("mcp__kybern__kybern_notes_search"), "Notes")
  const settled = (name, input) => ({ call: call(name, input), complete: true, isError: false })
  assert.equal(
    summarizeToolCalls([settled("mcp__kybern__kybern_notes_search", { query: "x" }), settled("mcp__kybern__kybern_task_read", { task: "ADE-1" }), settled("mcp__kybern__kybern_note_read", {})]).label,
    "Searched 1 time · read 2 notes and tasks",
  )
})

test("summaries put what changed first and join phrases with a middle dot", () => {
  const settled = (name, input) => ({ call: call(name, input), complete: true, isError: false })
  assert.equal(
    summarizeToolCalls([
      settled("Read", { file_path: "src/a.ts" }),
      settled("Grep", { pattern: "x" }),
      settled("Bash", { command: "pnpm test" }),
      settled("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      settled("Read", { file_path: "src/b.ts" }),
      settled("Grep", { pattern: "y" }),
    ])?.label,
    "Edited 1 file · ran 1 command · read 2 files · searched 2 times",
  )
  assert.deepEqual(toolSummaryPhrases([settled("Grep", { pattern: "x" })]), ["searched 1 time"], "one call still counts, lower case")
  assert.deepEqual(toolSummaryPhrases([]), [])
})

test("tool targets name the files, command or query a chip shows", () => {
  assert.deepEqual(toolTarget(call("Read", { file_path: "/w/src/Hero.tsx" })), { kind: "files", paths: ["/w/src/Hero.tsx"] })
  assert.deepEqual(toolTarget(call("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })), { kind: "files", paths: ["/w/a.ts"] })
  assert.deepEqual(toolTarget(call("apply_patch", { changes: [{ path: "/w/a.ts" }, { path: "/w/b.ts" }] })), { kind: "files", paths: ["/w/a.ts", "/w/b.ts"] })
  assert.deepEqual(toolTarget(call("Bash", { command: "bun test" })), { kind: "command", command: "bun test" })
  assert.deepEqual(toolTarget(call("shell", { command: `/bin/zsh -lc "pnpm typecheck"` })), { kind: "command", command: "pnpm typecheck" })
  assert.deepEqual(toolTarget(call("Bash", { command: "cat src/system.css" })), { kind: "files", paths: ["src/system.css"] }, "a reading command names its file")
  assert.deepEqual(toolTarget(call("Grep", { pattern: "chunkWork", path: "src" })), { kind: "query", query: "chunkWork", scope: "src" })
  assert.deepEqual(toolTarget(call("Bash", { command: "rg useFresh src" })), { kind: "query", query: "useFresh" })
  assert.deepEqual(toolTarget(call("WebSearch", { query: "gpui list" })), { kind: "query", query: "gpui list", scope: "the web" })
  assert.equal(toolTarget(call("Bash", { command: "git status" })), null, "git status keeps its own label")
  assert.equal(toolTarget(call("TodoWrite", { todos: [] })), null)
})

test("line counts of an edit skip the lines both sides share", () => {
  assert.deepEqual(toolLineCounts(call("Edit", { file_path: "a", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" })), { additions: 2, deletions: 1 })
  assert.deepEqual(toolLineCounts(call("MultiEdit", { file_path: "a", edits: [{ old_string: "x", new_string: "y" }, { old_string: "", new_string: "z\nw" }] })), { additions: 3, deletions: 1 })
  assert.deepEqual(toolLineCounts(call("Write", { file_path: "a", content: "one\ntwo\n" })), { additions: 2, deletions: 0 })
  assert.deepEqual(toolLineCounts(call("apply_patch", { changes: [{ path: "a", diff: "--- a\n+++ a\n@@\n-old\n+new\n+more\n ctx" }] })), { additions: 2, deletions: 1 })
  assert.equal(toolLineCounts(call("Read", { file_path: "a" })), null)
})
