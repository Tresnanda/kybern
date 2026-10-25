import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { DeferredReads } from '../shell/deferredReads.ts'
import { startupMark } from '../perf/startup.ts'
import { memoryStep } from '../perf/memoryLog.ts'
import { createStreamTopology } from './streamBlocks.ts'
import { pendingFor, removePending, settledPending, subscribePending, withPending } from '../composer/pending.ts'
// Transcript-side state and actions, mirroring `apps/desktop/src/state/rpc.ts`
// for the parts the transcript owns: approvals, saved tool output, turn diffs,
// earlier history pages, and per-row disclosure state that must survive a row
// being unmounted by the virtual list.
import { useContext, useMemo, useEffect, useState, useSyncExternalStore } from 'react'
import { TranscriptRowStateScope } from './rowStateScope.ts'
import { prependThreadHistory, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { EARLIER_HISTORY_PAGE, historyPageShowedNothing, historyTop } from '../../../../packages/kybern-client/src/historyPaging.ts'
import type { ApprovalDecision, Diff, Thread, ThreadEvent, ThreadId, TurnId } from '../../../../packages/kybern-client/src/types.ts'
import { useNav } from '../nav/store.ts'
import { getClient, getThreadSession, primeThreadHistory, takeThreadHistory, reloadPaneThread, getThreadOpen, setThreadOpen, getFocusedPaneId, getPane, getPaneState, onThreadEvent, subscribe, useApp, usePaneAccess, usePaneId } from '../state.ts'
import { readClipboardText as readSystemClipboardText, writeClipboardText } from '../platform/os.ts'

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
/** Perf harnesses only (`perf/tree`): the starting value of a row nobody has toggled yet; undefined keeps the row's own. */
let rowDefault: ((key: string) => unknown) | null = null
export function setRowStateDefault(value: ((key: string) => unknown) | null) {
  rowDefault = value
}

/** Disclosure state keyed by row identity: a row scrolled out of the virtual
 *  list and back keeps whether it was open. */
export function useRowState<T>(key: string, initial: T): [T, (value: T) => void] {
  key = `${usePaneId()}:${key}`
  const scope = useContext(TranscriptRowStateScope)
  const [value, setValue] = useState<T>(() => (scope?.has(key) ? scope.get(key) as T : rowState.has(key) ? rowState.get(key) as T : (rowDefault?.(key) as T | undefined) ?? initial))
  return [
    value,
    (next: T) => {
      scope?.set(key, next)
      rowState.delete(key)
      rowState.set(key, next)
      if (rowState.size > 2000) rowState.delete(rowState.keys().next().value!)
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
  void writeClipboardText(text).catch(() => {})
}

/** The clipboard's text (a pasted sign-in code). Empty when it holds none or cannot be read. */
export function readClipboardText(): Promise<string> {
  return readSystemClipboardText().catch(() => '')
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
  if (hydrating.has(key) || !getThreadOpen(threadId)) return
  hydrating.add(key)
  const session = getThreadSession(threadId)
  const owner = activeEnvironment()
  try {
    const result = await rpc().call('threads.tool_output', {
      thread_id: threadId,
      tool_call_id: block.call.id,
      start_seq: block.seq,
      through_seq: getThreadOpen(threadId)!.lastSeq,
      include_tool_stream: !!block.streamOmitted,
    })
    if (owner !== activeEnvironment()) return
    const open = getThreadOpen(threadId)
    if (owner !== activeEnvironment() || getThreadSession(threadId) !== session || !open) return
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
    setThreadOpen(threadId, { ...open, blocks })
  } catch (error) {
    if (owner !== activeEnvironment()) return
    reportError('Unable to load tool result', error)
  } finally {
    if (owner === activeEnvironment()) hydrating.delete(key)
  }
}

// ---- turn diffs (`loadDiff`, `loadFileDiff`) ----

const diffs = new Map<string, Diff | null>()
const diffCell = createCell(0)
const diffLoads = new Set<string>()
const diffReads = new DeferredReads(4)

export function useTurnDiff(threadId: ThreadId, turnId: TurnId, enabled: boolean): Diff | undefined {
  useSyncExternalStore(diffCell.subscribe, diffCell.get)
  const key = `${threadId}:${turnId}`
  const client = getClient()
  if (enabled && client && !diffs.has(key) && !diffLoads.has(key)) {
    diffLoads.add(key)
    const owner = activeEnvironment()
    const session = getThreadSession(threadId)
    const valid = () => owner === activeEnvironment() && client === getClient() && session === getThreadSession(threadId)
    // A fast thread switch used to stack another 30 metadata reads on the
    // startup burst and exhaust the daemon's request lane. Newest queued rows
    // go first; closed sessions never issue their queued reads.
    void diffReads.run(() => valid() ? client.call('threads.diff', { thread_id: threadId, turn_id: turnId, include_patch: false }) : Promise.resolve(null))
      .then(d => { if (valid()) diffs.set(key, d) })
      .catch(() => { if (valid()) diffs.set(key, null) }) // no git, no diff
      .finally(() => {
        if (owner !== activeEnvironment()) return
        diffLoads.delete(key)
        diffCell.set(diffCell.get() + 1)
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
  const owner = activeEnvironment()
  const result = await loadFileDiff(threadId, path, turnId)
  const patch = { text: hunksOnly(result.patch ?? ''), truncated: !!result.patch_truncated }
  if (owner === activeEnvironment()) patches.set(patchKey(threadId, turnId, path), patch)
  return patch
}

export async function revertTo(threadId: ThreadId, turnId: TurnId) {
  const paneId = getFocusedPaneId()
  const generation = getPane(paneId)?.generation
  const owner = activeEnvironment()
  await rpc().call('threads.revert', { thread_id: threadId, turn_id: turnId })
  if (owner !== activeEnvironment()) return
  for (const key of [...diffs.keys()]) if (key.startsWith(`${threadId}:`)) diffs.delete(key)
  for (const key of [...patches.keys()]) if (key.startsWith(`${threadId}:`)) patches.delete(key)
  diffCell.set(diffCell.get() + 1)
  if (getPane(paneId)?.generation === generation) void reloadPaneThread(paneId, threadId)
}

// ---- earlier history (`loadEarlier`) ----

export const earlierError = createCell<string | null>(null)
const earlierErrors = new Map<string, ReturnType<typeof createCell<string | null>>>()
const earlierLoads = new Map<string, Promise<boolean>>()
function errorFor(id: string) {
  let cell = earlierErrors.get(id)
  if (!cell) { cell = createCell<string | null>(null); earlierErrors.set(id, cell) }
  return cell
}
export function useEarlierError() {
  const id = useApp(s => s.selectedId)
  const cell = id ? errorFor(id) : earlierError
  return useSyncExternalStore(cell.subscribe, cell.get)
}
/** Shared paging per thread; each pane retains its own virtual-list anchor.
 *  Resolves true when the page left the oldest turn as it was (no new turn,
 *  prompt still missing): the reader at the top saw nothing new. */
export function loadEarlier(paneId = getFocusedPaneId()): Promise<boolean> {
  const threadId = getPaneState(paneId).selectedId
  if (!threadId) return Promise.resolve(false)
  const pending = earlierLoads.get(threadId)
  if (pending) return pending
  const base = getThreadOpen(threadId)
  if (!base?.loaded || base.nextBeforeSeq == null || base.loadingEarlier) return Promise.resolve(false)
  const cursor = base.nextBeforeSeq
  const owner = activeEnvironment(), client = getClient(), session = getThreadSession(threadId)
  const events: ThreadEvent[] = []
  const stop = onThreadEvent((id, event) => { if (id === threadId) events.push(event) })
  const error = errorFor(threadId)
  error.set(null)
  setThreadOpen(threadId, { ...base, loadingEarlier: true })
  const valid = (): boolean => owner === activeEnvironment() && client === getClient() && earlierLoads.get(threadId) === pendingLoad && getThreadSession(threadId) === session && !!getThreadOpen(threadId)
  const prefetched = takeThreadHistory(threadId, base)
  const request = () => rpc().call('threads.get', {
    thread_id: threadId, include_tool_output: false, defer_tool_stream: true,
    ...EARLIER_HISTORY_PAGE, before_seq: cursor, through_seq: base.lastSeq,
  })
  const pendingLoad: Promise<boolean> = (prefetched ? prefetched.then(page => page ?? (valid() ? request() : null)) : request()).then(page => {
    if (!page || !valid()) return false
    const started = performance.now()
    const next = prependThreadHistory(base, page, events.filter(event => event.seq > base.lastSeq), getThreadOpen(threadId)!)
    startupMark('history-projected', { cursor, durationMs: performance.now() - started, entries: page.transcript.length })
    setThreadOpen(threadId, next)
    memoryStep('history-page', { id: threadId, entries: page.transcript.length, blocks: next.blocks.length })
    startupMark('history-ready', { cursor: base.nextBeforeSeq, entries: page.transcript.length })
    primeThreadHistory(threadId)
    return next.nextBeforeSeq != null && historyPageShowedNothing(historyTop(base.blocks), historyTop(next.blocks))
  }).catch(reason => {
    if (!valid()) return false
    error.set(errorText(reason))
    setThreadOpen(threadId, { ...getThreadOpen(threadId)!, loadingEarlier: false })
    return false
  }).finally(() => { stop(); if (earlierLoads.get(threadId) === pendingLoad) earlierLoads.delete(threadId) })
  earlierLoads.set(threadId, pendingLoad)
  startupMark('history-start', { cursor: base.nextBeforeSeq, prefetched: !!prefetched })
  return pendingLoad
}

// ---- paced live updates ----

/** Streaming deltas arrive tens of times a second and every commit makes GPUI
 *  lay out the whole window. The transcript reads blocks through this pace: a
 *  change after a quiet spell commits at once, a burst commits at most every
 *  PACE_MS (the desktop's smooth stream commits every 32ms for the same reason). */
export const PACE_MS = 66

export function usePacedBlocks(): Block[] {
  const pane = usePaneAccess()
  const threadId = useApp(s => s.selectedId)
  const [frame, setFrame] = useState(() => ({ threadId: pane.get().selectedId, blocks: pane.get().open.blocks }))
  useEffect(() => {
    const topology = createStreamTopology()
    let shown = pane.get().open.blocks
    let shownPending = pendingFor(pane.get().selectedId)
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      clearTimeout(timer)
      timer = undefined
      last = Date.now()
      shown = pane.get().open.blocks
      const threadId = pane.get().selectedId
      // Optimistic sends (`composer/pending.ts`) join as user blocks until the daemon's own block with their id arrives.
      shownPending = pendingFor(threadId)
      const settled = settledPending(shown, shownPending)
      if (settled.length && threadId) queueMicrotask(() => { for (const id of settled) removePending(threadId, id) })
      const merged = withPending(shown, shownPending)
      const blocks = process.env.KYBERN_STREAM_ISOLATE === '0' ? merged : topology(merged)
      setFrame(previous => previous.threadId === threadId && previous.blocks === blocks ? previous : { threadId, blocks })
    }
    const stop = pane.frozen ? () => {} : subscribe(() => {
      if (pane.get().open.blocks === shown || timer) return
      const wait = PACE_MS - (Date.now() - last)
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    })
    // A send shows on the frame of its Enter: never paced.
    const stopPending = pane.frozen ? () => {} : subscribePending(() => { if (pendingFor(pane.get().selectedId) !== shownPending) flush() })
    flush()
    return () => {
      stop()
      stopPending()
      clearTimeout(timer)
    }
  }, [pane])
  // Never paint a previous thread’s paced frame under the next thread’s id.
  return frame.threadId === threadId ? frame.blocks : withPending(pane.get().open.blocks, pendingFor(threadId))
}

/** A live row owns its changing text; the transcript above it subscribes only
 * to grouping transitions. Frozen outgoing panes keep their captured blocks. */
export function usePacedAssistant(block: Extract<Block, {kind: 'assistant'}>) {
  const pane = usePaneAccess()
  const [shown, setShown] = useState(block)
  useEffect(() => {
    if (pane.frozen || block.complete || process.env.KYBERN_STREAM_ISOLATE === '0') return
    let last = 0, timer: ReturnType<typeof setTimeout> | undefined
    let current = block
    const read = () => {
      const blocks = pane.get().open.blocks
      for (let i = blocks.length - 1; i >= 0; i--) {
        const candidate = blocks[i]!
        if (candidate.id === block.id && candidate.kind === 'assistant' && candidate.turnId === block.turnId) return candidate
      }
      return block
    }
    const flush = () => {
      timer = undefined
      last = Date.now()
      current = read()
      setShown(current)
    }
    const stop = subscribe(() => {
      if (read() === current || timer) return
      const wait = PACE_MS - (Date.now() - last)
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    })
    flush()
    return () => { stop(); clearTimeout(timer) }
  }, [pane, block.id, block.turnId, block.complete])
  return pane.frozen || block.complete || process.env.KYBERN_STREAM_ISOLATE === '0' || shown.id !== block.id || shown.turnId !== block.turnId ? block : shown
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
  const live = useNav(s => s.children)
  useEffect(() => {
    if (!enabled || childLoads.has(parentId)) return
    const current = childThreads.get(parentId)
    if (current && Date.now() - current.at < CHILDREN_STALE_MS) return
    childLoads.add(parentId)
    const owner = activeEnvironment()
    rpc()
      .call('threads.list', { parent_thread_id: parentId })
      .then((result) => { if (owner === activeEnvironment()) childThreads.set(parentId, { at: Date.now(), threads: result.threads }) })
      .catch(() => {})
      .finally(() => {
        if (owner !== activeEnvironment()) return
        childLoads.delete(parentId)
        childCell.set(childCell.get() + 1)
      })
  }, [parentId, enabled])
  return useMemo(() => {
    const merged = new Map((cached?.threads ?? EMPTY_THREADS).map(child => [child.id, child]))
    for (const child of Object.values(live)) if (child.parent_thread_id === parentId) merged.set(child.id, child)
    return [...merged.values()].filter(child => child.status !== 'archived')
  }, [cached, live, parentId])
}

onEnvironmentChange(() => { resetRowState(); diffs.clear(); diffLoads.clear(); hydrating.clear(); childThreads.clear(); childLoads.clear(); earlierLoads.clear(); earlierErrors.clear(); clearTimeout(actionErrorTimer); actionError.set(null); earlierError.set(null); })
