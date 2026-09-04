// Persisted client-side layout for split chat threads. The recursive binary tree
// follows Synara's split-view model: depth is capped at two, yielding a calm 2x2
// maximum instead of letting panes become unusably small.

import type { ThreadId } from "../protocol"

export type PaneId = string
export type SplitDirection = "horizontal" | "vertical"
export type SplitSide = "first" | "second"

export interface ThreadPane {
  kind: "leaf"
  id: PaneId
  threadId: ThreadId | null
}

export interface SplitNode {
  kind: "split"
  id: PaneId
  direction: SplitDirection
  first: Pane
  second: Pane
  ratio: number
}

export type Pane = ThreadPane | SplitNode

export interface SplitView {
  root: SplitNode
  focusedPaneId: PaneId
}

export const SPLIT_RATIO_MIN = 0.25
export const SPLIT_RATIO_MAX = 0.75
export const SPLIT_RATIO_DEFAULT = 0.5

const SPLIT_VIEW_STORAGE_KEY = "kybern.split-view.v1"
const SPLIT_VIEW_STORAGE_VERSION = 1

function paneId(): PaneId {
  return crypto.randomUUID()
}

export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_RATIO_DEFAULT
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value))
}

export function createThreadPane(threadId: ThreadId | null): ThreadPane {
  return { kind: "leaf", id: paneId(), threadId }
}

export function createSplitNode(input: {
  direction: SplitDirection
  first: Pane
  second: Pane
  ratio?: number
}): SplitNode {
  return {
    kind: "split",
    id: paneId(),
    direction: input.direction,
    first: input.first,
    second: input.second,
    ratio: clampSplitRatio(input.ratio ?? SPLIT_RATIO_DEFAULT),
  }
}

export function createSplitView(input: {
  sourceThreadId: ThreadId
  threadId?: ThreadId | null
  direction: SplitDirection
  side?: SplitSide
}): SplitView {
  const source = createThreadPane(input.sourceThreadId)
  const added = createThreadPane(input.threadId ?? null)
  const root = createSplitNode(
    input.side === "first"
      ? { direction: input.direction, first: added, second: source }
      : { direction: input.direction, first: source, second: added }
  )
  return { root, focusedPaneId: added.id }
}

export function collectThreadPanes(root: Pane): ThreadPane[] {
  if (root.kind === "leaf") return [root]
  return [...collectThreadPanes(root.first), ...collectThreadPanes(root.second)]
}

export function collectSplitThreadIds(splitView: SplitView | null): ThreadId[] {
  if (!splitView) return []
  const ids = collectThreadPanes(splitView.root)
    .map((pane) => pane.threadId)
    .filter((threadId): threadId is ThreadId => threadId !== null)
  return [...new Set(ids)]
}

export function findPane(root: Pane, id: PaneId): Pane | null {
  if (root.id === id) return root
  if (root.kind === "leaf") return null
  return findPane(root.first, id) ?? findPane(root.second, id)
}

export function findThreadPane(root: Pane, id: PaneId): ThreadPane | null {
  const pane = findPane(root, id)
  return pane?.kind === "leaf" ? pane : null
}

export function findThreadPaneByThreadId(
  root: Pane,
  threadId: ThreadId
): ThreadPane | null {
  return (
    collectThreadPanes(root).find((pane) => pane.threadId === threadId) ?? null
  )
}

export function findParentSplit(root: Pane, id: PaneId): SplitNode | null {
  if (root.kind === "leaf") return null
  if (root.first.id === id || root.second.id === id) return root
  return findParentSplit(root.first, id) ?? findParentSplit(root.second, id)
}

export function findPaneDepth(root: Pane, id: PaneId): number | null {
  if (root.id === id) return 0
  if (root.kind === "leaf") return null
  const firstDepth = findPaneDepth(root.first, id)
  if (firstDepth !== null) return firstDepth + 1
  const secondDepth = findPaneDepth(root.second, id)
  return secondDepth === null ? null : secondDepth + 1
}

export function canSplitPane(
  root: Pane,
  id: PaneId,
  direction: SplitDirection
): boolean {
  if (!findThreadPane(root, id)) return false
  const depth = findPaneDepth(root, id)
  if (depth === null || depth >= 2) return false
  const parent = findParentSplit(root, id)
  return parent === null || parent.direction !== direction
}

export function replacePane(root: Pane, id: PaneId, replacement: Pane): Pane {
  if (root.id === id) return replacement
  if (root.kind === "leaf") return root
  const first = replacePane(root.first, id, replacement)
  const second = replacePane(root.second, id, replacement)
  return first === root.first && second === root.second
    ? root
    : { ...root, first, second }
}

export function replacePaneThread(
  root: Pane,
  id: PaneId,
  threadId: ThreadId | null
): Pane {
  const current = findThreadPane(root, id)
  if (!current || current.threadId === threadId) return root
  return replacePane(root, id, { ...current, threadId })
}

export function splitThreadPane(input: {
  root: Pane
  targetPaneId: PaneId
  direction: SplitDirection
  threadId?: ThreadId | null
  side?: SplitSide
}): { root: Pane; addedPaneId: PaneId } | null {
  const target = findThreadPane(input.root, input.targetPaneId)
  if (!target || !canSplitPane(input.root, input.targetPaneId, input.direction))
    return null
  const added = createThreadPane(input.threadId ?? null)
  const split = createSplitNode(
    input.side === "first"
      ? { direction: input.direction, first: added, second: target }
      : { direction: input.direction, first: target, second: added }
  )
  return {
    root: replacePane(input.root, input.targetPaneId, split),
    addedPaneId: added.id,
  }
}

export function setSplitNodeRatio(root: Pane, id: PaneId, ratio: number): Pane {
  const current = findPane(root, id)
  if (current?.kind !== "split") return root
  const nextRatio = clampSplitRatio(ratio)
  if (nextRatio === current.ratio) return root
  return replacePane(root, id, { ...current, ratio: nextRatio })
}

/** Remove one leaf and collapse its parent into the surviving sibling. */
export function removeThreadPane(root: Pane, id: PaneId): Pane | null {
  if (root.kind === "leaf") return root.id === id ? null : root
  if (root.first.id === id) return root.second
  if (root.second.id === id) return root.first

  const first = removeThreadPane(root.first, id)
  if (first !== root.first) {
    if (!first) return root.second
    return { ...root, first }
  }
  const second = removeThreadPane(root.second, id)
  if (second !== root.second) {
    if (!second) return root.first
    return { ...root, second }
  }
  return root
}

export function resolveFocusedThreadPane(
  splitView: SplitView
): ThreadPane | null {
  return findThreadPane(splitView.root, splitView.focusedPaneId)
}

export function resolveFocusedThreadId(
  splitView: SplitView | null,
  fallback = false
): ThreadId | null {
  if (!splitView) return null
  const focused = resolveFocusedThreadPane(splitView)
  if (focused?.threadId) return focused.threadId
  if (!fallback) return null
  return (
    collectThreadPanes(splitView.root).find((pane) => pane.threadId)
      ?.threadId ?? null
  )
}

export function resolveDefaultFocusPaneId(root: Pane): PaneId {
  const panes = collectThreadPanes(root)
  return panes.find((pane) => pane.threadId)?.id ?? panes[0]?.id ?? root.id
}

export function reconcileSplitView(
  splitView: SplitView | null,
  availableThreadIds: ReadonlySet<ThreadId>
): SplitView | null {
  if (!splitView) return null
  const seen = new Set<ThreadId>()
  const reconcilePane = (pane: Pane): Pane => {
    if (pane.kind === "leaf") {
      const threadId = pane.threadId
      if (
        !threadId ||
        !availableThreadIds.has(threadId) ||
        seen.has(threadId)
      ) {
        return threadId === null ? pane : { ...pane, threadId: null }
      }
      seen.add(threadId)
      return pane
    }
    const first = reconcilePane(pane.first)
    const second = reconcilePane(pane.second)
    return first === pane.first && second === pane.second
      ? pane
      : { ...pane, first, second }
  }

  const root = reconcilePane(splitView.root)
  if (collectThreadPanes(root).every((pane) => pane.threadId === null))
    return null
  const focused = findThreadPane(root, splitView.focusedPaneId)
  const focusedPaneId = focused?.threadId
    ? focused.id
    : resolveDefaultFocusPaneId(root)
  return root === splitView.root && focusedPaneId === splitView.focusedPaneId
    ? splitView
    : { root: root as SplitNode, focusedPaneId }
}

function parsePane(
  value: unknown,
  depth: number,
  ids: Set<string>
): Pane | null {
  if (!value || typeof value !== "object" || depth > 2) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== "string" || ids.has(candidate.id)) return null
  ids.add(candidate.id)

  if (candidate.kind === "leaf") {
    if (candidate.threadId !== null && typeof candidate.threadId !== "string")
      return null
    return {
      kind: "leaf",
      id: candidate.id,
      threadId: candidate.threadId as ThreadId | null,
    }
  }
  if (
    candidate.kind !== "split" ||
    (candidate.direction !== "horizontal" && candidate.direction !== "vertical")
  )
    return null
  const first = parsePane(candidate.first, depth + 1, ids)
  const second = parsePane(candidate.second, depth + 1, ids)
  if (!first || !second || typeof candidate.ratio !== "number") return null
  return {
    kind: "split",
    id: candidate.id,
    direction: candidate.direction,
    first,
    second,
    ratio: clampSplitRatio(candidate.ratio),
  }
}

export function readPersistedSplitView(): SplitView | null {
  try {
    const raw = globalThis.localStorage?.getItem(SPLIT_VIEW_STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as { version?: unknown; splitView?: unknown }
    if (
      stored.version !== SPLIT_VIEW_STORAGE_VERSION ||
      !stored.splitView ||
      typeof stored.splitView !== "object"
    )
      return null
    const candidate = stored.splitView as Record<string, unknown>
    const root = parsePane(candidate.root, 0, new Set())
    if (root?.kind !== "split" || typeof candidate.focusedPaneId !== "string")
      return null
    const focusedPaneId = findThreadPane(root, candidate.focusedPaneId)
      ? candidate.focusedPaneId
      : resolveDefaultFocusPaneId(root)
    return { root, focusedPaneId }
  } catch {
    return null
  }
}

export function persistSplitView(splitView: SplitView | null): void {
  try {
    if (!splitView) {
      globalThis.localStorage?.removeItem(SPLIT_VIEW_STORAGE_KEY)
      return
    }
    globalThis.localStorage?.setItem(
      SPLIT_VIEW_STORAGE_KEY,
      JSON.stringify({ version: SPLIT_VIEW_STORAGE_VERSION, splitView })
    )
  } catch {
    // Layout persistence is a convenience; storage denial must not break the app.
  }
}
