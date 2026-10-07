// Lineage: the "Agents" dock tab of an ordinary thread. A tree of the agents this thread started:
// Kybern-delegated children (writable), harness-native subagents (read-only) and legacy helper
// threads. Coordinator threads keep CollaborationPane. The pane does nothing while its tab is not
// the active one: no subscriptions, no loads, no rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { lineageSummary, stoppableDescendants } from "../../../../../packages/kybern-client/src/delegations.ts"
import { VirtualRows } from "@/components/kybern/VirtualRows"
import { Button } from "@/components/kit/button"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/kit/alert-dialog"
import { StopIcon, UsersIcon } from "@/lib/kit/icons"
import type { Thread, ThreadId } from "@/protocol"
import { removeKeptWorktree, stopDelegatedChildren, useLineageCounts, useLineageRows, useLineageThreads } from "@/state/delegations"
import { loadLineage } from "@/state/rpc"
import { LineageRowView } from "./LineageRow"

/** Rows past this count are virtualized in the pane's own scroller; fewer stay in normal flow. */
const VIRTUALIZE_AFTER = 30

/** What the reader opened or closed, kept while the tab is hidden and the pane unmounted. */
const choices = new Map<ThreadId, { tree: Record<string, boolean>; detail: Record<string, boolean> }>()
function choicesFor(threadId: ThreadId) {
  let value = choices.get(threadId)
  if (!value) {
    if (choices.size >= 40) choices.delete(choices.keys().next().value!)
    value = { tree: {}, detail: {} }
    choices.set(threadId, value)
  }
  return value
}

export function LineagePane({ threadId, active }: { threadId: ThreadId; active: boolean }) {
  if (!active) return null
  return <LineageBody threadId={threadId} />
}

const getKey = (row: { thread: Thread }) => row.thread.id
const estimate = () => 64

function LineageBody({ threadId }: { threadId: ThreadId }) {
  const threads = useLineageThreads(threadId)
  const [tree, setTree] = useState(() => ({ ...choicesFor(threadId).tree }))
  const [detail, setDetail] = useState(() => ({ ...choicesFor(threadId).detail }))
  const [removing, setRemoving] = useState<Thread | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // The empty state waits for the first load, so a thread with children never flashes it.
  const [loaded, setLoaded] = useState(false)

  // Seed the tree once per visit; live changes arrive as events.
  useEffect(() => {
    let current = true
    loadLineage(threadId).catch(() => undefined).finally(() => { if (current) setLoaded(true) })
    return () => { current = false }
  }, [threadId])

  const rows = useLineageRows(threads, threadId, tree)
  const counts = useLineageCounts(threads, threadId)
  const stoppable = useMemo(() => stoppableDescendants(rows), [rows])
  const summary = lineageSummary(counts)

  const toggleTree = useCallback((id: string, open: boolean) => {
    setTree((current) => {
      const next = { ...current, [id]: open }
      choicesFor(threadId).tree = next
      return next
    })
  }, [threadId])
  const toggleDetail = useCallback((id: string) => {
    setDetail((current) => {
      const next = { ...current, [id]: !current[id] }
      choicesFor(threadId).detail = next
      return next
    })
  }, [threadId])
  const askRemove = useCallback((thread: Thread) => setRemoving(thread), [])

  if (rows.length === 0) return loaded ? <LineageEmpty /> : null
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-lineage-pane="">
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 ps-3.5 pe-2.5 pt-1">
        <p role="status" aria-live="polite" className="min-w-0 truncate text-xs text-foreground/55">
          {summary || (counts.total === 1 ? "1 agent" : `${counts.total} agents`)}
        </p>
        {stoppable.length >= 2 && (
          <Button variant="ghost" size="chip" onClick={() => void stopDelegatedChildren(stoppable)}>
            <StopIcon /> Stop all
          </Button>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
        <div role="list" aria-label="Agents started by this thread" className="flex flex-col gap-px">
          <VirtualRows items={rows} getKey={getKey} estimateSize={estimate} viewport={rows.length > VIRTUALIZE_AFTER ? scroller : undefined} followEnd={false}>
            {(row) => (
              <LineageRowView
                row={row}
                detailOpen={!!detail[row.thread.id]}
                onToggleDetail={toggleDetail}
                onToggleTree={toggleTree}
                onRemoveWorktree={askRemove}
              />
            )}
          </VirtualRows>
        </div>
      </div>
      <RemoveWorktreeDialog thread={removing} onClose={() => setRemoving(null)} />
    </div>
  )
}

function LineageEmpty() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-8 pb-10 text-center" data-lineage-empty="">
      <UsersIcon className="size-5 text-foreground/35" aria-hidden />
      <div className="flex max-w-[16rem] flex-col gap-1">
        <p className="text-[13px] font-medium text-foreground/85">No agents yet</p>
        <p className="text-xs leading-5 text-foreground/55 text-pretty">Ask the agent to delegate work to another agent; children appear here.</p>
      </div>
    </div>
  )
}

/** The one destructive action: it deletes files on disk, so it asks first. */
function RemoveWorktreeDialog({ thread, onClose }: { thread: Thread | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  // Keep the last thread while the dialog fades out, so its text does not blank mid-exit.
  const [shown, setShown] = useState<Thread | null>(thread)
  if (thread && thread !== shown) setShown(thread)
  const target = thread ?? shown
  const branch = target?.delegation?.branch
  const remove = async () => {
    if (!thread || busy) return
    setBusy(true)
    const removed = await removeKeptWorktree(thread)
    setBusy(false)
    if (removed) onClose()
  }
  return (
    <AlertDialog open={thread !== null} onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">Remove this worktree?</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            {target?.title ? `“${target.title}” ` : "This agent "}left its worktree on disk because it has changes
            {branch ? <> on <span className="font-mono text-[0.92em]">{branch}</span></> : null} that are not merged. Removing it deletes those files from this Mac.
            The branch is deleted only if it is already merged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="chrome-outline" />} disabled={busy}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove worktree"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
