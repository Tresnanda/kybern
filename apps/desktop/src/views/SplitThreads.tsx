import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"

import { ChatPaneDropOverlay } from "@/components/kybern/ChatPaneDropOverlay"
import { ErrorBoundary } from "@/components/kybern/ErrorBoundary"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
import { ProviderMark } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { Columns2Icon, XIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { Thread, ThreadId } from "@/protocol"
import { loadThread } from "@/state/rpc"
import {
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  canSplitPane,
  clampSplitRatio,
  collectSplitThreadIds,
  collectThreadPanes,
  type Pane,
  type PaneId,
  type SplitNode,
  type SplitView,
  type ThreadPane,
} from "@/state/splitView"
import { useStore } from "@/state/store"

import { ThreadView } from "./Thread"

export function SplitThreads({ splitView }: { splitView: SplitView }) {
  const threads = useStore((state) => state.threads)
  const setRatio = useStore((state) => state.setSplitRatio)
  const openThreadIds = useMemo(
    () => new Set(collectSplitThreadIds(splitView)),
    [splitView]
  )
  const primaryPaneId = collectThreadPanes(splitView.root)[0]?.id ?? null

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-split-thread-view="true"
    >
      <PaneRenderer
        pane={splitView.root}
        splitView={splitView}
        threads={threads}
        openThreadIds={openThreadIds}
        primaryPaneId={primaryPaneId}
        onSetRatio={setRatio}
      />
    </div>
  )
}

function PaneRenderer(props: {
  pane: Pane
  splitView: SplitView
  threads: Record<ThreadId, Thread>
  openThreadIds: ReadonlySet<ThreadId>
  primaryPaneId: PaneId | null
  onSetRatio: (nodeId: PaneId, ratio: number) => void
}): ReactNode {
  if (props.pane.kind === "leaf") {
    return (
      <SplitThreadPane
        key={props.pane.id}
        pane={props.pane}
        splitView={props.splitView}
        threads={props.threads}
        openThreadIds={props.openThreadIds}
        primary={props.pane.id === props.primaryPaneId}
      />
    )
  }
  return (
    <SplitNodeRenderer
      key={props.pane.id}
      node={props.pane}
      splitView={props.splitView}
      threads={props.threads}
      openThreadIds={props.openThreadIds}
      primaryPaneId={props.primaryPaneId}
      onSetRatio={props.onSetRatio}
    />
  )
}

function SplitNodeRenderer({
  node,
  splitView,
  threads,
  openThreadIds,
  primaryPaneId,
  onSetRatio,
}: {
  node: SplitNode
  splitView: SplitView
  threads: Record<ThreadId, Thread>
  openThreadIds: ReadonlySet<ThreadId>
  primaryPaneId: PaneId | null
  onSetRatio: (nodeId: PaneId, ratio: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLDivElement>(null)
  const latestRatio = useRef(node.ratio)
  const [dragging, setDragging] = useState(false)
  const horizontal = node.direction === "horizontal"

  useEffect(() => {
    latestRatio.current = node.ratio
    if (!dragging && firstRef.current)
      firstRef.current.style.flexBasis = `${node.ratio * 100}%`
  }, [dragging, node.ratio])

  const commitRatio = useCallback(
    (ratio: number) => {
      latestRatio.current = clampSplitRatio(ratio)
      if (firstRef.current)
        firstRef.current.style.flexBasis = `${latestRatio.current * 100}%`
      onSetRatio(node.id, latestRatio.current)
    },
    [node.id, onSetRatio]
  )

  const startResize = (event: ReactPointerEvent) => {
    const container = containerRef.current
    const first = firstRef.current
    if (!container || !first) return
    event.preventDefault()

    const rect = container.getBoundingClientRect()
    const size = horizontal ? rect.width : rect.height
    if (size <= 0) return

    const handle = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const startPosition = horizontal ? event.clientX : event.clientY
    const startRatio = latestRatio.current
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    let frame = 0
    let pendingRatio = startRatio

    const apply = () => {
      frame = 0
      latestRatio.current = pendingRatio
      first.style.flexBasis = `${pendingRatio * 100}%`
      handle.setAttribute(
        "aria-valuenow",
        String(Math.round(pendingRatio * 100))
      )
    }
    const move = (moveEvent: PointerEvent) => {
      const position = horizontal ? moveEvent.clientX : moveEvent.clientY
      pendingRatio = clampSplitRatio(
        startRatio + (position - startPosition) / size
      )
      if (!frame) frame = requestAnimationFrame(apply)
    }
    const finish = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        apply()
      }
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId)
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", finish)
      handle.removeEventListener("pointercancel", finish)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setDragging(false)
      onSetRatio(node.id, latestRatio.current)
    }

    handle.setPointerCapture(pointerId)
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", finish)
    handle.addEventListener("pointercancel", finish)
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize"
    document.body.style.userSelect = "none"
    setDragging(true)
  }

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let ratio: number | null = null
    if (event.key === "Home") ratio = SPLIT_RATIO_MIN
    if (event.key === "End") ratio = SPLIT_RATIO_MAX
    if (horizontal && event.key === "ArrowLeft")
      ratio = latestRatio.current - 0.05
    if (horizontal && event.key === "ArrowRight")
      ratio = latestRatio.current + 0.05
    if (!horizontal && event.key === "ArrowUp")
      ratio = latestRatio.current - 0.05
    if (!horizontal && event.key === "ArrowDown")
      ratio = latestRatio.current + 0.05
    if (ratio === null) return
    event.preventDefault()
    commitRatio(ratio)
  }

  return (
    <div
      ref={containerRef}
      data-split-direction={node.direction}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden",
        horizontal ? "flex-row" : "flex-col"
      )}
    >
      <div
        ref={firstRef}
        className={cn(
          "relative flex min-h-0 min-w-0 shrink overflow-hidden",
          horizontal
            ? "border-r border-[color:var(--app-surface-divider)]"
            : "border-b border-[color:var(--app-surface-divider)]"
        )}
        style={{ flexBasis: `${node.ratio * 100}%`, flexGrow: 0 }}
      >
        <PaneRenderer
          pane={node.first}
          splitView={splitView}
          threads={threads}
          openThreadIds={openThreadIds}
          primaryPaneId={primaryPaneId}
          onSetRatio={onSetRatio}
        />
        <ResizeHandle
          edge={horizontal ? "right" : "bottom"}
          label={
            horizontal
              ? "Resize thread panes horizontally"
              : "Resize thread panes vertically"
          }
          valueNow={Math.round(node.ratio * 100)}
          dragging={dragging}
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
          onReset={() => commitRatio(SPLIT_RATIO_DEFAULT)}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneRenderer
          pane={node.second}
          splitView={splitView}
          threads={threads}
          openThreadIds={openThreadIds}
          primaryPaneId={primaryPaneId}
          onSetRatio={onSetRatio}
        />
      </div>
    </div>
  )
}

function SplitThreadPane({
  pane,
  splitView,
  threads,
  openThreadIds,
  primary,
}: {
  pane: ThreadPane
  splitView: SplitView
  threads: Record<ThreadId, Thread>
  openThreadIds: ReadonlySet<ThreadId>
  primary: boolean
}) {
  const focusPane = useStore((state) => state.focusSplitPane)
  const closePane = useStore((state) => state.closeSplitPane)
  const dropThread = useStore((state) => state.dropThreadOnPane)
  const thread = pane.threadId ? threads[pane.threadId] : null
  const focused = splitView.focusedPaneId === pane.id
  const focus = () => {
    if (!focused) focusPane(pane.id)
  }

  return (
    <section
      role="group"
      aria-label={
        thread?.title ? `${thread.title} thread pane` : "Empty thread pane"
      }
      data-focused={focused}
      data-split-thread-pane={pane.id}
      className="split-thread-pane relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--color-background-surface)]"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <ChatPaneDropOverlay
        excludedThreadIds={openThreadIds}
        wholePaneDrop={!thread}
        canDropInDirection={(direction) =>
          !thread || canSplitPane(splitView.root, pane.id, direction)
        }
        onDropThread={({ threadId, direction, side }) => {
          if (dropThread(pane.id, threadId, direction, side))
            void loadThread(threadId)
        }}
      >
        {thread ? (
          <ErrorBoundary key={thread.id} label="this split thread">
            <ThreadView
              threadId={thread.id}
              splitPaneId={pane.id}
              isFocused={focused}
              showSidebarControls={primary}
            />
          </ErrorBoundary>
        ) : (
          <SplitPaneEmptyState
            paneId={pane.id}
            threads={threads}
            excludedThreadIds={openThreadIds}
            onClose={() => closePane(pane.id)}
          />
        )}
      </ChatPaneDropOverlay>
    </section>
  )
}

function SplitPaneEmptyState({
  paneId,
  threads,
  excludedThreadIds,
  onClose,
}: {
  paneId: PaneId
  threads: Record<ThreadId, Thread>
  excludedThreadIds: ReadonlySet<ThreadId>
  onClose: () => void
}) {
  const focusPane = useStore((state) => state.focusSplitPane)
  const selectThread = useStore((state) => state.selectThread)
  const candidates = useMemo(
    () =>
      Object.values(threads)
        .filter(
          (thread) =>
            thread.status !== "archived" && !excludedThreadIds.has(thread.id)
        )
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 6),
    [excludedThreadIds, threads]
  )

  const choose = (threadId: ThreadId) => {
    focusPane(paneId)
    selectThread(threadId)
    void loadThread(threadId)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-72 flex-col items-center text-center">
        <span className="mb-3 inline-flex size-8 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)]">
          <Columns2Icon className="size-4" />
        </span>
        <h2 className="text-[length:var(--app-font-size-ui-lg,13px)] leading-tight font-medium text-foreground">
          Choose a thread
        </h2>
        <p className="mt-1 max-w-60 text-[length:var(--app-font-size-ui-sm,11px)] leading-[1.45] text-pretty text-muted-foreground">
          Select one from the sidebar or drag it into this pane.
        </p>
        {candidates.length > 0 && (
          <div className="mt-4 flex w-full flex-col gap-0.5 text-start">
            {candidates.map((thread) => (
              <Button
                key={thread.id}
                variant="ghost"
                size="sm"
                className="w-full min-w-0 justify-start px-2 font-normal"
                title={thread.title || "Untitled"}
                onClick={() => choose(thread.id)}
              >
                <ProviderMark
                  kind={thread.provider.kind}
                  size={14}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 truncate">
                  {thread.title || "Untitled"}
                </span>
              </Button>
            ))}
          </div>
        )}
        <Button
          variant="chrome-outline"
          size="xs"
          className="mt-4"
          onClick={onClose}
        >
          <XIcon className="size-3.5" /> Close pane
        </Button>
      </div>
    </div>
  )
}
