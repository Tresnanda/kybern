import assert from "node:assert/strict"
import test from "node:test"

import { toolLine } from "./src/lib/toolActivity.ts"

const call = (name, input) => ({ id: "tool-1", name, input })

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
