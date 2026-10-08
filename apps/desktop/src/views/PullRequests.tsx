// Pull requests route: the list is the only sidebar. Wide, list and detail sit
// side by side; narrow, one pane shows at a time.

import { useEffect, useRef } from "react"

import { Kbd } from "@/components/kit/kbd"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
import { useResize } from "@/lib/hooks"
import { GitPullRequestIcon } from "@/lib/kit/icons"
import { useStore } from "@/state/store"

import { PrReview } from "./PrReview"
import { PrList } from "./pullRequests/PrList"
import { prRowId } from "./pullRequests/prIds"
import { PR_FINE_TEXT, PR_QUIET_INK } from "./pullRequests/prText"
import { cn } from "@/lib/utils"
import "./pullRequests/review.css"

const LIST_DEFAULT = 352
const KEY_STEP = 16

export function PullRequests() {
  const selection = useStore((s) => s.prSelection)
  const resize = useResize({
    initial: LIST_DEFAULT,
    min: 288,
    max: 512,
    side: "left",
    storageKey: "kybern.pulls.listWidth",
  })
  const listRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLElement>(null)

  const backToList = () => {
    const selectedRow = selection && prRowId(selection.projectId, selection.number)
    useStore.getState().set({ prSelection: null })
    requestAnimationFrame(() => {
      if (selectedRow) document.getElementById(selectedRow)?.focus()
    })
  }

  // Esc returns to the list in single-pane mode, unless a field, popover or dialog owns it.
  useEffect(() => {
    const detail = detailRef.current
    if (!detail || !selection) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-slot="popover-popup"]'
        )
      )
        return
      if (document.querySelector('[role="dialog"], [data-slot="popover-popup"]')) return
      const list = listRef.current
      if (!list || getComputedStyle(list).display !== "none") return
      backToList()
    }
    detail.addEventListener("keydown", onKey)
    return () => detail.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  return (
    <div
      className="pr-inbox relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]"
      data-detail-open={!!selection}
      style={{ "--pr-list-width": `${resize.width}px` } as React.CSSProperties}
    >
      <div className="pr-inbox-layout">
        <aside ref={listRef} className="pr-inbox-list" aria-label="Pull requests list">
          <PrList
            onOpenSearchKey={() => {
              // Single pane: ⌘F brings the list back so the search field is visible.
              const list = listRef.current
              if (list && getComputedStyle(list).display === "none") backToList()
            }}
          />
          <ResizeHandle
            edge="right"
            label="Resize pull request list"
            onPointerDown={resize.onPointerDown}
            dragging={resize.dragging}
            onReset={() => resize.setWidth(LIST_DEFAULT)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP
              if (event.key === "ArrowLeft") resize.setWidth(resize.width - step)
              else if (event.key === "ArrowRight") resize.setWidth(resize.width + step)
              else return
              event.preventDefault()
            }}
            className="pr-resize"
          />
        </aside>
        {selection ? (
          <section
            ref={detailRef}
            className="pr-inbox-detail"
            aria-label="Selected pull request"
          >
            <PrReview
              key={`${selection.projectId}:${selection.number}`}
              projectId={selection.projectId}
              number={selection.number}
              onBack={backToList}
            />
          </section>
        ) : (
          <div className="pr-inbox-detail pr-inbox-placeholder items-center justify-center gap-2 p-6 text-center">
            <GitPullRequestIcon className={cn("mb-1 size-7", PR_QUIET_INK)} />
            <p className="font-medium text-foreground">Select a pull request</p>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              Read its summary, review changes and send findings to an agent.
            </p>
            <p className={cn("mt-2 flex items-center gap-1.5", PR_FINE_TEXT, PR_QUIET_INK)}>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move · <Kbd>Enter</Kbd> to open
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
