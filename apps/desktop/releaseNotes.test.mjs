import assert from "node:assert/strict"
import test from "node:test"

import { releasePresentation } from "./src/lib/releaseNotes.ts"

test("uses optional authored copy without displaying its metadata comments", () => {
  const notes = `<!-- kybern-release-title: Coordinate work across agents -->
<!-- kybern-release-summary: Assign focused tasks and follow their progress from one thread. -->
## What's changed

- Added project coordinators.`

  const result = releasePresentation("0.4.0", notes)
  assert.equal(result.title, "Coordinate work across agents")
  assert.equal(
    result.summary,
    "Assign focused tasks and follow their progress from one thread."
  )
  assert.doesNotMatch(result.notes ?? "", /kybern-release-/)
  assert.match(result.notes ?? "", /Added project coordinators\./)
  assert.equal(
    result.url,
    "https://github.com/Tresnanda/kybern/releases/tag/v0.4.0"
  )
})

test("derives copy from ordinary Markdown without inventing a feature", () => {
  const notes = `## Terminal reliability

- Keep terminal sessions connected while the window is hidden.

**Full Changelog**: [v0.3.9...v0.4.0](https://github.com/Tresnanda/kybern/compare/v0.3.9...v0.4.0)`

  const result = releasePresentation("v0.4.0", notes)
  assert.equal(result.title, "Terminal reliability")
  assert.equal(
    result.summary,
    "Keep terminal sessions connected while the window is hidden."
  )
  assert.equal(result.notes, notes)
  assert.equal(
    result.url,
    "https://github.com/Tresnanda/kybern/releases/tag/v0.4.0"
  )
})

test("uses generic copy for missing and legacy link-only notes", () => {
  const expected = {
    title: "Kybern 0.4.0 is available",
    summary: "See what changed in this release.",
    notes: null,
    url: "https://github.com/Tresnanda/kybern/releases/tag/v0.4.0",
  }

  assert.deepEqual(releasePresentation("0.4.0", null), expected)
  assert.deepEqual(
    releasePresentation(
      "0.4.0",
      "Release notes: https://github.com/Tresnanda/kybern/releases/tag/v0.4.0"
    ),
    expected
  )
})

test("does not turn cargo-dist installer boilerplate into a feature claim", () => {
  const notes = `## Install kybern 0.4.0

### Install prebuilt binaries via shell script

\`\`\`sh
curl https://example.com/installer.sh | sh
\`\`\`

## Download kybern 0.4.0

| File | Platform |
| --- | --- |
| kybern.tar.xz | macOS |`

  assert.deepEqual(releasePresentation("0.4.0", notes), {
    title: "Kybern 0.4.0 is available",
    summary: "See what changed in this release.",
    notes,
    url: "https://github.com/Tresnanda/kybern/releases/tag/v0.4.0",
  })
})

test("bounds Markdown copy and encodes unexpected version text in the URL", () => {
  const result = releasePresentation(
    "next/beta",
    `# **${"A long release headline ".repeat(8)}**\n\n- [${"A long summary ".repeat(30)}](https://example.com)`
  )

  assert.ok(Array.from(result.title).length <= 80)
  assert.ok(Array.from(result.summary).length <= 180)
  assert.equal(
    result.url,
    "https://github.com/Tresnanda/kybern/releases/tag/vnext%2Fbeta"
  )
  assert.match(result.title, /\u2026$/)
  assert.match(result.summary, /\u2026$/)
})
