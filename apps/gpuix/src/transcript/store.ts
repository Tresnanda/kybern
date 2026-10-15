// Transcript-side state and actions, mirroring `apps/desktop/src/state/rpc.ts`
// for the parts the transcript owns: approvals, saved tool output, turn diffs,
// earlier history pages, and per-row disclosure state that must survive a row
// being unmounted by the virtual list.
import { spawn } from 'node:child_process'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { prependThreadHistory, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { EARLIER_HISTORY_ENTRIES } from '../../../../packages/kybern-client/src/historyPaging.ts'
import type { ApprovalDecision, Diff, Thread, ThreadEvent, ThreadId, TurnId } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, getState, onOpenEvent, selectThread, set, subscribe } from '../state.ts'

export type ToolBlock = Extract<Block, { kind: 'tool' }>

/** Daemon errors as one readable line (`errorText` in the desktop). */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

function rpc() {
  const client = getClient()
  if (!client) throw new Error('Not connected')
  return client
}

// ---- row state (`useTranscriptRowState`) ----

const rowState = new Map<string, unknown>()

/** Disclosure state keyed by row identity: a row scrolled out of the virtual
 *  list and back keeps whether it was open. */
export function useRowState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (rowState.has(key) ? (rowState.get(key) as T) : initial))
  return [
    value,
    (next: T) => {
      rowState.set(key, next)
      setValue(next)
    },
  ]
}

/** Forget row state when another thread opens, so ids never leak across threads. */
export function resetRowState() {
  rowState.clear()
  patches.clear()
}

// ---- tiny external stores ----

function createCell<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

// ---- clipboard ----

export function copyText(text: string) {
  const p = spawn('pbcopy')
  p.on('error', () => {})
  p.stdin.end(text)
}

// ---- approvals and questions ----

export async function respondApproval(id: string, decision: ApprovalDecision) {
  await rpc().call('approvals.respond', { approval_id: id, ...decision })
}

export async function interrupt(threadId: ThreadId) {
  await rpc().call('threads.interrupt', { thread_id: threadId })
}

export async function answerQuestions(threadId: ThreadId, requestId: string, answers: string[]) {
  await rpc().call('threads.answer', { thread_id: threadId, request_id: requestId, answers })
}

/** Surface errors from an action that has no inline place to show them. */
export const actionError = createCell<string | null>(null)
let actionErrorTimer: ReturnType<typeof setTimeout> | undefined
export function reportError(title: string, error: unknown) {
  actionError.set(`${title}. ${errorText(error)}`)
  clearTimeout(actionErrorTimer)
  actionErrorTimer = setTimeout(() => actionError.set(null), 6000)
}
export const useActionError = () => useSyncExternalStore(actionError.subscribe, actionError.get)

// ---- saved tool output (`hydrateToolOutput`) ----

const hydrating = new Set<string>()

/** Fetch an omitted result or stream once and fold it into the open transcript. */
export async function hydrateToolOutput(threadId: ThreadId, block: ToolBlock) {
  if (!block.outputOmitted && !block.streamOmitted) return
  const key = `${threadId}:${block.call.id}:${block.seq}`
  if (hydrating.has(key) || getState().selectedId !== threadId) return
  hydrating.add(key)
  try {
    const result = await rpc().call('threads.tool_output', {
      thread_id: threadId,
      tool_call_id: block.call.id,
      start_seq: block.seq,
      through_seq: getState().open.lastSeq,
      include_tool_stream: !!block.streamOmitted,
    })
    const open = getState().open
    if (getState().selectedId !== threadId) return
    const index = open.blocks.findIndex(
      (b) => b.kind === 'tool' && b.call.id === block.call.id && b.seq === block.seq && (b.outputOmitted || b.streamOmitted),
    )
    const current = open.blocks[index]
    if (!current || current.kind !== 'tool') return
    const blocks = open.blocks.slice()
    blocks[index] = {
      ...current,
      output: current.outputOmitted ? result.output : current.output,
      stream: current.streamOmitted ? (result.stream ?? '') : current.stream,
      isError: result.is_error,
      outputOmitted: false,
      streamOmitted: false,
    }
    set({ open: { ...open, blocks } })
  } catch (error) {
    reportError('Unable to load tool result', error)
  } finally {
    hydrating.delete(key)
  }
}

// ---- turn diffs (`loadDiff`, `loadFileDiff`) ----

const diffs = new Map<string, Diff | null>()
const diffCell = createCell(0)
const diffLoads = new Set<string>()

export function useTurnDiff(threadId: ThreadId, turnId: TurnId, enabled: boolean): Diff | undefined {
  useSyncExternalStore(diffCell.subscribe, diffCell.get)
  const key = `${threadId}:${turnId}`
  if (enabled && !diffs.has(key) && !diffLoads.has(key)) {
    diffLoads.add(key)
    queueMicrotask(() => {
      rpc()
        .call('threads.diff', { thread_id: threadId, turn_id: turnId, include_patch: false })
        .then((d) => diffs.set(key, d))
        .catch(() => diffs.set(key, null)) // no git, no diff
        .finally(() => {
          diffLoads.delete(key)
          diffCell.set(diffCell.get() + 1)
        })
    })
  }
  return diffs.get(key) ?? undefined
}

export function loadFileDiff(threadId: ThreadId, path: string, turnId: TurnId): Promise<Diff> {
  return rpc().call('threads.diff', { thread_id: threadId, turn_id: turnId, include_patch: true, path })
}

/** The card's file row is the header (`FileDiffBody` has none), so the native
 *  diff gets only the hunks: no file header or "New file" notice of its own. */
function hunksOnly(patch: string): string {
  const start = patch.search(/^@@ /m)
  return start < 0 ? patch : patch.slice(start)
}

export interface FilePatch {
  text: string
  truncated: boolean
}
const patches = new Map<string, FilePatch>()
const patchKey = (threadId: ThreadId, turnId: TurnId, path: string) => `${threadId}:${turnId}:${path}`

/** A file's loaded patch, kept across row remounts (virtual list, disclosures). */
export const filePatch = (threadId: ThreadId, turnId: TurnId, path: string): FilePatch | null => patches.get(patchKey(threadId, turnId, path)) ?? null

export async function loadFilePatch(threadId: ThreadId, path: string, turnId: TurnId): Promise<FilePatch> {
  const result = await loadFileDiff(threadId, path, turnId)
  const patch = { text: hunksOnly(result.patch ?? ''), truncated: !!result.patch_truncated }
  patches.set(patchKey(threadId, turnId, path), patch)
  return patch
}

export async function revertTo(threadId: ThreadId, turnId: TurnId) {
  await rpc().call('threads.revert', { thread_id: threadId, turn_id: turnId })
  for (const key of [...diffs.keys()]) if (key.startsWith(`${threadId}:`)) diffs.delete(key)
  for (const key of [...patches.keys()]) if (key.startsWith(`${threadId}:`)) patches.delete(key)
  diffCell.set(diffCell.get() + 1)
  void selectThread(threadId)
}

// ---- earlier history (`loadEarlier`) ----

export const earlierError = createCell<string | null>(null)
export const useEarlierError = () => useSyncExternalStore(earlierError.subscribe, earlierError.get)
let earlierLoad: Promise<void> | null = null

/** Load the page before the oldest loaded entry at a frozen sequence, replaying
 *  any live events that arrived meanwhile (`prependThreadHistory`). */
export function loadEarlier(): Promise<void> {
  if (earlierLoad) return earlierLoad
  const threadId = getState().selectedId
  const base = getState().open
  if (!threadId || !base.loaded || base.nextBeforeSeq == null || base.loadingEarlier) return Promise.resolve()
  const events: ThreadEvent[] = []
  const stop = onOpenEvent((event) => events.push(event))
  earlierError.set(null)
  set({ open: { ...base, loadingEarlier: true } })
  earlierLoad = rpc()
    .call('threads.get', {
      thread_id: threadId,
      include_tool_output: false,
      defer_tool_stream: true,
      transcript_limit: EARLIER_HISTORY_ENTRIES,
      before_seq: base.nextBeforeSeq,
      through_seq: base.lastSeq,
    })
    .then((page) => {
      if (getState().selectedId !== threadId) return
      const replay = events.filter((event) => event.seq > base.lastSeq)
      set({ open: prependThreadHistory(base, page, replay, getState().open) })
    })
    .catch((error) => {
      if (getState().selectedId !== threadId) return
      earlierError.set(errorText(error))
      set({ open: { ...getState().open, loadingEarlier: false } })
    })
    .finally(() => {
      stop()
      earlierLoad = null
    })
  return earlierLoad
}

// ---- layout shared with the composer overlay ----

/** Height of the request panel stacked on the composer, so the transcript's
 *  bottom inset grows with it like the desktop's `bottomInset`. */
export const requestPanelHeight = createCell(0)
export const useRequestPanelHeight = () => useSyncExternalStore(requestPanelHeight.subscribe, requestPanelHeight.get)

// ---- paced live updates ----

/** Streaming deltas arrive tens of times a second and every commit makes GPUI
 *  lay out the whole window. The transcript reads blocks through this pace: a
 *  change after a quiet spell commits at once, a burst commits at most every
 *  PACE_MS (the desktop's smooth stream commits every 32ms for the same reason). */
export const PACE_MS = 66

export function usePacedBlocks(): Block[] {
  const [blocks, setBlocks] = useState(() => getState().open.blocks)
  useEffect(() => {
    let shown = getState().open.blocks
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      last = Date.now()
      shown = getState().open.blocks
      setBlocks(shown)
    }
    const stop = subscribe(() => {
      if (getState().open.blocks === shown || timer) return
      const wait = PACE_MS - (Date.now() - last)
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    })
    flush()
    return () => {
      stop()
      clearTimeout(timer)
    }
  }, [])
  return blocks
}

// ---- child threads (subagents and delegations a thread launched) ----

const childThreads = new Map<string, { at: number; threads: Thread[] }>()
const childCell = createCell(0)
const childLoads = new Set<string>()
const EMPTY_THREADS: Thread[] = []
/** Refetch a parent's children when a launch row mounts and the copy is older than this. */
const CHILDREN_STALE_MS = 5000

/** The direct subagent and delegated children of a thread (`threads.list
 *  { parent_thread_id }`, a read), so launch rows can open their thread. */
export function useChildThreads(parentId: ThreadId, enabled: boolean): Thread[] {
  useSyncExternalStore(childCell.subscribe, childCell.get)
  const cached = childThreads.get(parentId)
  useEffect(() => {
    if (!enabled || childLoads.has(parentId)) return
    const current = childThreads.get(parentId)
    if (current && Date.now() - current.at < CHILDREN_STALE_MS) return
    childLoads.add(parentId)
    rpc()
      .call('threads.list', { parent_thread_id: parentId })
      .then((result) => childThreads.set(parentId, { at: Date.now(), threads: result.threads }))
      .catch(() => {})
      .finally(() => {
        childLoads.delete(parentId)
        childCell.set(childCell.get() + 1)
      })
  }, [parentId, enabled])
  return cached?.threads ?? EMPTY_THREADS
}
