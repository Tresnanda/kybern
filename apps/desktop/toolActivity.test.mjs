import assert from "node:assert/strict"
import test from "node:test"

import { buildStructuredTextParts } from "./src/lib/composerTokens.ts"
import { getAttachmentIconName, getFileIconName } from "./src/lib/synara/fileIcons.ts"
import {
  humanizeToolName,
  runtimeActivityPrompt,
  runtimeActivityResult,
  summarizeToolCalls,
  toolLine,
  toolVisualKind,
} from "./src/lib/toolActivity.ts"

const call = (name, input) => ({ id: "tool-1", name, input })

test("Synara file icons distinguish common project and attachment types", () => {
  assert.equal(getFileIconName("Cargo.toml"), "rust")
  assert.equal(getFileIconName("src/App.tsx"), "react")
  assert.equal(getFileIconName("docs/RTK.md"), "markdown")
  assert.equal(getFileIconName(".gitignore"), "git")
  assert.equal(getAttachmentIconName({ name: "scan", mimeType: "application/pdf" }), "file-pdf")
})

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
    "Ran 1 command and delegated 1 task"
  )
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

  const browser = call("mcp__cua_repl__js", { title: "Open settings" })
  assert.equal(humanizeToolName(browser.name), "Browser · Js")
  assert.equal(toolVisualKind(browser), "web")
  assert.deepEqual(toolLine(browser, true), {
    verb: "Used",
    detail: "Browser · Js — Open settings",
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
    label: "Ran 1 command and read 2 files",
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

test("composer preserves spaced skill names as structured provider references", () => {
  const skill = {
    name: "Expo UI SwiftUI",
    path: "/skills/expo-ui-swiftui/SKILL.md",
    scope: "user",
    enabled: true,
  }
  assert.deepEqual(
    buildStructuredTextParts(
      "Use $Expo UI SwiftUI with @src/App.tsx and keep $HOME.",
      new Set(["src/App.tsx"]),
      [skill]
    ),
    [
      { type: "text", text: "Use " },
      { type: "skill", name: "Expo UI SwiftUI", path: skill.path },
      { type: "text", text: " with " },
      { type: "file_mention", path: "src/App.tsx" },
      { type: "text", text: " and keep $HOME." },
    ]
  )
})
