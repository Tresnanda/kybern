import assert from "node:assert/strict"
import test from "node:test"

import {
  dropZoneAt,
  hasCrossedThreadDragThreshold,
  splitForZone,
} from "./src/components/kybern/chatPaneDrag.ts"
import {
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  canSplitPane,
  clampSplitRatio,
  closeSplitViewPane,
  collectThreadPanes,
  createSplitView,
  findThreadPaneByThreadId,
  reconcileSplitView,
  removeThreadPane,
  splitThreadPane,
} from "./src/state/splitView.ts"

test("a split opens the requested thread on the requested side", () => {
  const view = createSplitView({
    sourceThreadId: "thread-a",
    threadId: "thread-b",
    direction: "horizontal",
    side: "first",
  })

  assert.equal(view.root.direction, "horizontal")
  assert.deepEqual(
    collectThreadPanes(view.root).map((pane) => pane.threadId),
    ["thread-b", "thread-a"]
  )
  assert.equal(view.focusedPaneId, view.root.first.id)
})

test("perpendicular subdivision allows a 2x2 grid but prevents unusable nesting", () => {
  const view = createSplitView({
    sourceThreadId: "thread-a",
    threadId: "thread-b",
    direction: "horizontal",
  })
  const left = view.root.first
  const right = view.root.second

  assert.equal(canSplitPane(view.root, left.id, "horizontal"), false)
  assert.equal(canSplitPane(view.root, left.id, "vertical"), true)

  const leftResult = splitThreadPane({
    root: view.root,
    targetPaneId: left.id,
    threadId: "thread-c",
    direction: "vertical",
  })
  assert.ok(leftResult)
  assert.equal(
    canSplitPane(leftResult.root, leftResult.addedPaneId, "horizontal"),
    false
  )
  assert.equal(
    canSplitPane(leftResult.root, leftResult.addedPaneId, "vertical"),
    false
  )

  const rightResult = splitThreadPane({
    root: leftResult.root,
    targetPaneId: right.id,
    threadId: "thread-d",
    direction: "vertical",
  })
  assert.ok(rightResult)
  assert.deepEqual(
    collectThreadPanes(rightResult.root).map((pane) => pane.threadId),
    ["thread-a", "thread-c", "thread-b", "thread-d"]
  )
})

test("closing a pane collapses its parent into the surviving sibling", () => {
  const view = createSplitView({
    sourceThreadId: "thread-a",
    threadId: "thread-b",
    direction: "horizontal",
  })
  const remaining = removeThreadPane(view.root, view.root.second.id)

  assert.equal(remaining?.kind, "leaf")
  assert.equal(remaining?.threadId, "thread-a")
})

test("closing a three-pane layout preserves the final visible thread", () => {
  const view = createSplitView({
    sourceThreadId: "thread-a",
    threadId: "thread-b",
    direction: "horizontal",
  })
  const nested = splitThreadPane({
    root: view.root,
    targetPaneId: view.root.second.id,
    threadId: "thread-c",
    direction: "vertical",
  })
  assert.ok(nested)

  const threePaneView = {
    root: nested.root,
    focusedPaneId: nested.addedPaneId,
  }
  const withoutC = closeSplitViewPane(threePaneView, nested.addedPaneId)
  assert.ok(withoutC?.splitView)
  assert.equal(withoutC.threadId, "thread-b")

  const paneB = findThreadPaneByThreadId(
    withoutC.splitView.root,
    "thread-b"
  )
  assert.ok(paneB)
  const onlyA = closeSplitViewPane(withoutC.splitView, paneB.id)
  assert.equal(onlyA?.splitView, null)
  assert.equal(onlyA?.threadId, "thread-a")
})

test("restored layouts clear missing and duplicate threads", () => {
  const view = createSplitView({
    sourceThreadId: "thread-a",
    threadId: "thread-b",
    direction: "horizontal",
  })
  const restored = reconcileSplitView(view, new Set(["thread-a"]))

  assert.ok(restored)
  assert.deepEqual(
    collectThreadPanes(restored.root).map((pane) => pane.threadId),
    ["thread-a", null]
  )
  assert.equal(restored.focusedPaneId, restored.root.first.id)
})

test("split ratios remain in the usable quarter-to-three-quarter range", () => {
  assert.equal(clampSplitRatio(-1), SPLIT_RATIO_MIN)
  assert.equal(clampSplitRatio(2), SPLIT_RATIO_MAX)
  assert.equal(clampSplitRatio(Number.NaN), 0.5)
})

test("thread drops choose intuitive edges and respect allowed directions", () => {
  const widePane = { left: 100, top: 100, width: 900, height: 500 }
  const anyDirection = () => true

  assert.equal(dropZoneAt(widePane, 120, 350, anyDirection), "left")
  assert.equal(dropZoneAt(widePane, 980, 350, anyDirection), "right")
  assert.equal(dropZoneAt(widePane, 550, 110, anyDirection), "top")
  assert.equal(
    dropZoneAt(widePane, 550, 590, (direction) => direction === "vertical"),
    "bottom"
  )
  assert.equal(dropZoneAt(widePane, 550, 350, () => false), null)
})

test("every drop preview maps to the matching split side", () => {
  assert.deepEqual(splitForZone("left"), {
    direction: "horizontal",
    side: "first",
  })
  assert.deepEqual(splitForZone("right"), {
    direction: "horizontal",
    side: "second",
  })
  assert.deepEqual(splitForZone("top"), {
    direction: "vertical",
    side: "first",
  })
  assert.deepEqual(splitForZone("bottom"), {
    direction: "vertical",
    side: "second",
  })
})

test("thread dragging waits for deliberate pointer movement", () => {
  assert.equal(hasCrossedThreadDragThreshold(10, 10, 13, 13), false)
  assert.equal(hasCrossedThreadDragThreshold(10, 10, 16, 10), true)
  assert.equal(hasCrossedThreadDragThreshold(10, 10, 10, 3), true)
})
