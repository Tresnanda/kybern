import { SparseRetention, sparseIndices, useSparseList } from './kit/sparseList.tsx'
import { TRANSCRIPT_SCROLL_LAYOUT } from './transcript/scroll-layout.ts'
import { TranscriptSlot, useTranscriptWindow } from './transcript/Window.tsx'
import { TranscriptRowStateScope } from './transcript/rowStateScope.ts'
import { SubagentDivider } from './subagents/Page.tsx'
import { observeElementBounds, type LayoutRect } from './native/layout.ts'
// The thread transcript (`views/Transcript.tsx`): turns grouped by the shared
// `groupTurns`, rows centred at 736px inside 56px gutters, a date line where a
// day starts, a virtual list that follows the tail, earlier pages loaded when
// the top comes into view (reading position kept), and the 32px "Scroll to
// bottom" button while away from the tail. Rows live in `transcript/`.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { createTurnGrouper, type TurnGroup } from '../../../packages/kybern-client/src/transcript.ts'
import { calendarDateKey } from '../../desktop/src/lib/format.ts'
import { Icon } from './icons.tsx'
import { MatrixLoader } from './MatrixLoader.tsx'
import { subscribe, useApp, usePaneAccess, usePaneCompact } from './state.ts'
import { Label, REDUCED_MOTION, useTheme } from './ui.tsx'
import { DISTANCE, DURATION, EASE } from './motion/kit.tsx'
import { CodeChunk, CodeHeader, markdownParts, partGap, Prose, textChunks } from './transcript/markdown.tsx'
import { MermaidBlock } from './transcript/MermaidBlock.tsx'
import { MessageRail, type RailItem } from './transcript/rail.tsx'
import { createTranscriptNavigation } from '../../desktop/src/lib/transcriptNavigation.ts'
import { T } from './transcript/glyphs.ts'
import { alpha, muted, Para } from './transcript/kit.tsx'
import { over } from './theme.ts'
import { AnswerImages, DateSeparator, Turn, TurnFooter, turnTimestamp } from './transcript/Turn.tsx'
import { loadEarlier, useActionError, useEarlierError, usePacedBlocks, useRequestPanelHeight } from './transcript/store.ts'

export { markdownTheme } from './transcript/kit.tsx'

export const GUTTER = 56
export const COLUMN = 736
/** The floating composer's height plus 64 (`bottomInset + 64`, `Transcript.tsx:479`). */
const COMPOSER_INSET = 192
const turnKey = (group: TurnGroup, index: number) => group.turnId || group.user?.id || `turn-${index}`

type TurnNodes = Map<string, {row?: PublicInstance | null; user?: PublicInstance | null}>
type CodeState = { expanded: boolean; wrap: boolean; source?: boolean }
type SavedAnchor = { key: string; offset: number; tail: boolean; code: Record<string, CodeState> }
const scrollAnchors = new Map<string, SavedAnchor>()

export function Transcript() {
  const pane = usePaneAccess()
  const t = useTheme()
  const renderer = useGpuixRequired()
  const threadId = useApp((s) => s.selectedId)
  const thread = useApp(s => s.open.thread)
  const blocks = usePacedBlocks()
  const loaded = useApp((s) => s.open.loaded)
  const hasEarlier = useApp((s) => s.open.nextBeforeSeq != null)
  const loadingEarlier = useApp((s) => !!s.open.loadingEarlier)
  const threadRunning = useApp((s) => s.open.thread?.status === 'running' || s.open.thread?.status === 'awaiting-approval')
  const earlierError = useEarlierError()
  const actionError = useActionError()
  const panelHeight = useRequestPanelHeight()
  const groupTurns = useMemo(() => createTurnGrouper(), [threadId])
  const turns = useMemo(() => groupTurns(blocks), [blocks, groupTurns])
  const rowStateScope = useMemo(() => new Map<string, unknown>(), [threadId])
  const list = useRef<PublicInstance>(null)
  const turnNodes = useRef<TurnNodes>(new Map())
  const [jump, setJump] = useState<{id:string;index:number;generation:number} | null>(null)
  // The virtual list reports no element bounds (its rect is always null), so the
  // viewport size comes from the surface around it, which fills the same box.
  const [surfaceNode, setSurfaceNode] = useState<PublicInstance | null>(null)
  const [topNode, setTopNode] = useState<PublicInstance | null>(null)
  const [bottomNode, setBottomNode] = useState<PublicInstance | null>(null)
  const listRef = useCallback((node: PublicInstance | null) => { list.current = node }, [])
  const topRef = useCallback((node: PublicInstance | null) => setTopNode(node), [])
  const bottomRef = useCallback((node: PublicInstance | null) => setBottomNode(node), [])
  const surfaceRef = useCallback((node: PublicInstance | null) => setSurfaceNode(node), [])
  const [atTail, setAtTail] = useState(true)
  const [overflow, setOverflow] = useState(false)
  const [paneHeight, setPaneHeight] = useState(0)
  const [paneWidth, setPaneWidth] = useState(0)
  const jumpStop = useRef<(() => void) | null>(null)
  useEffect(() => () => jumpStop.current?.(), [threadId])
  useEffect(() => {
    if (!loaded || !turns.length || !surfaceNode) { setOverflow(false); return }
    const rects: Record<string, LayoutRect | null> = {}
    // A frozen outgoing page can share its pane id with the incoming transcript.
    // Observe these instances, never globally resolved test ids. Endpoint refs
    // also detach/rebind as the virtual list unmounts and restores its rows.
    const nodes = { viewport: surfaceNode, top: topNode, bottom: bottomNode }
    const stops = Object.entries(nodes).flatMap(([key, node]) => node ? [observeElementBounds(renderer, node.id, event => {
      rects[key] = event.rect
      const { viewport, top, bottom } = rects
      if (!viewport) return
      setPaneHeight(viewport.height)
      setPaneWidth(viewport.width)
      if (hasEarlier || (top && bottom)) setOverflow(hasEarlier || bottom!.y + bottom!.height - top!.y > viewport.height + 1)
      // Neither endpoint is painted when restoring into the middle of a long list.
      else setOverflow(true)
    })] : [])
    return () => stops.forEach(stop => stop())
  }, [renderer, surfaceNode, topNode, bottomNode, threadId, loaded, turns.length, hasEarlier])
  // One rail mark per user prompt, with the desktop's preview text (`lib/transcriptNavigation.ts`).
  const buildNavigation = useMemo(() => createTranscriptNavigation(), [threadId])
  const navigationItems = useMemo(() => buildNavigation(turns as never), [buildNavigation, turns])
  const railItems = useMemo<RailItem[]>(() => navigationItems.map(item => ({ id: item.id, label: item.label, description: item.description })), [navigationItems])
  const [codeState, setCodeState] = useState<Record<string, CodeState>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const nearTop = useRef(false)

  useEffect(() => {
    setCodeState(threadId ? scrollAnchors.get(`${pane.id}:${threadId}`)?.code ?? {} : {})
    setAtTail(threadId ? scrollAnchors.get(`${pane.id}:${threadId}`)?.tail ?? true : true)
    nearTop.current = false
  }, [threadId])
  // Consume one top-entry intent per page. Prepending or a retry must not
  // recursively download every older page without another reading gesture.

  // Every answer block/chunk is a direct virtual-list item. Expanding a 5k
  // line fence never mounts 5k native rows, nor adds a nested scroller.
  type RenderRow = {key: string; turn: TurnGroup; node: React.ReactNode; estimate?: number}
  const rowCache = useMemo(() => new Map<string, {turn: TurnGroup; date: string | null; isLast: boolean; running: boolean; code: typeof codeState; rows: RenderRow[]}>(), [threadId])
  const rows = useMemo(() => {
    const keep = new Set<string>()
    const next = turns.flatMap((turn, i) => {
      const key = turnKey(turn, i)
      const at = turnTimestamp(turn)
      const startsDay = !!at && ((!hasEarlier && i === 0) || (i > 0 && calendarDateKey(at) !== calendarDateKey(turnTimestamp(turns[i - 1]!))))
      const running = turn.running || (i === turns.length - 1 && threadRunning && !turn.end)
      const date = startsDay ? at : null, isLast = i === turns.length - 1
      keep.add(key)
      const cached = rowCache.get(key)
      if(cached && cached.turn === turn && cached.date === date && cached.isLast === isLast && cached.running === running && cached.code === codeState) return cached.rows
      const result: RenderRow[] = [{ key, turn, estimate: (turn.user ? 52 : 0) + (turn.work.length ? 36 : 0) + (startsDay ? 44 : 0), node: <TurnItem nodes={turnNodes.current} turn={turn} threadId={threadId!} isLast={i === turns.length - 1} threadRunning={i === turns.length - 1 && threadRunning} dateAt={startsDay ? at : null} /> }]
      const remember = () => { rowCache.set(key, {turn, date, isLast, running, code:codeState, rows:result}); return result }
      if (running) return remember()
      result.push({ key: `${key}:images`, turn, estimate: turn.images.length * 234, node: <Row><AnswerImages group={turn} threadId={threadId!} /></Row> })
      const parts = markdownParts(turn.answer?.text ?? '')
      for (const [partIndex, part] of parts.entries()) {
        const partKey = `${key}:answer:${part.key}`
        const chunks = textChunks(part.text)
        // Native Markdown owns spacing inside prose; separate virtual parts
        // share the desktop's collapsed margin at their boundary (`partGap`).
        if (partIndex > 0) result.push({ key: `${partKey}:before`, turn, estimate: partGap(parts[partIndex - 1]!, part), node: <div style={{ height: partGap(parts[partIndex - 1]!, part) }} /> })
        if (part.kind === 'code' && part.language === 'mermaid') {
          // One row: the header (Preview/Source, expand, copy) and the diagram or its source.
          const state = codeState[partKey] ?? { expanded: false, wrap: false }
          result.push({ key: partKey, turn, node: <Row><MermaidBlock code={part.text} source={!!state.source} onSource={source => setCodeState(value => ({ ...value, [partKey]: { ...state, source } }))} /></Row> })
        } else if (part.kind === 'code') {
          // Desktop code starts unwrapped; horizontal scrolling preserves long lines.
          const state = codeState[partKey] ?? { expanded: false, wrap: false }
          const update = (patch: Partial<typeof state>) => setCodeState(value => ({ ...value, [partKey]: { ...state, ...patch } }))
          result.push({ key: partKey, turn, estimate: 27.2, node: <Row><CodeHeader part={part} {...state} onWrap={() => update({ wrap: !state.wrap })} onExpand={chunks.length > 1 ? () => update({ expanded: !state.expanded }) : undefined} /></Row> })
          for (const [chunkIndex, chunk] of (state.expanded ? chunks : chunks.slice(0, 1)).entries()) {
            result.push({ key: `${partKey}:${chunkIndex}`, turn, node: <Row><CodeChunk text={chunk} language={part.language} wrap={state.wrap} first={chunkIndex === 0} last={!state.expanded || chunkIndex === chunks.length - 1} /></Row> })
          }
        } else {
          for (const [chunkIndex, chunk] of chunks.entries()) result.push({ key: `${partKey}:${chunkIndex}`, turn, node: <Row><Prose text={chunk} /></Row> })
        }
      }
      result.push({ key: `${key}:footer`, turn, estimate: 35, node: <Row><TurnFooter group={turn} threadId={threadId!} isLast={i === turns.length - 1} /></Row> })
      return remember()
    })
    for(const key of rowCache.keys()) if(!keep.has(key)) rowCache.delete(key)
    return next
  }, [turns, hasEarlier, threadId, threadRunning, codeState, rowCache])
  // A top spacer is present even without earlier history.
  const lead = 1
  const count = lead + rows.length + 1
  const freshUntil = useMemo(() => new Map(turns.map(turn => [turn, Date.parse(turnTimestamp(turn) ?? '') + 3000])), [turns])
  const now = Date.now()
  const rowKeys = useMemo(() => rows.map(row => row.key), [rows])
  const estimates = useMemo(() => rows.map(row => row.estimate ?? 160), [rows])
  const mountWindow = useTranscriptWindow(rowKeys, list, paneHeight, threadId, paneWidth, estimates, index => setActiveId(rows[index]?.turn.user?.id ?? null))
  // Reuse the element itself for unchanged slots. Memoizing the component alone
  // still allocates and compares thousands of fresh element/props objects on a
  // live-tail update or a mount-window boundary.
  const slotCache = useMemo(() => new Map<string, {mounted:boolean; height:number; node:React.ReactNode; element:React.ReactNode}>(), [threadId])
  useEffect(() => {
    const valid = new Set(rowKeys)
    for(const key of slotCache.keys()) if(!valid.has(key)) slotCache.delete(key)
  }, [rowKeys, slotCache])
  const sparse = process.env.KYBERN_SPARSE_LIST !== '0' && process.env.KYBERN_GPUIX_NATIVE !== 'npm' && process.env.KYBERN_TRANSCRIPT_WINDOW !== '0'
  const logicalKeys = useMemo(() => ['__top', ...rowKeys, '__bottom'], [rowKeys])
  // The mounted footer measures panel-height changes directly; keep that motion
  // from resending every historical estimate through the native bridge.
  const logicalEstimates = useMemo(() => [hasEarlier ? 48 : 16, ...estimates, COMPOSER_INSET], [estimates, hasEarlier])
  const nativeWindow = useSparseList(logicalKeys, logicalEstimates, `${threadId}:${paneWidth}:${t.variant}`)
  const pinnedCandidates = useMemo(() => rows.flatMap((row,index) => {
    const live = row.turn.running || (threadRunning && row.turn === turns.at(-1))
    const until = freshUntil.get(row.turn) ?? 0
    return live || (until > now && until < now + 6000) ? [{ index: index + 1, live, until }] : []
  }), [rows, threadRunning, turns, freshUntil])
  const pinnedRows = pinnedCandidates.filter(pin => pin.live || pin.until > now).map(pin => pin.index)
  const windowIndices = sparse ? sparseIndices(mountWindow.range.start + 1, mountWindow.range.end + 1, count,
    [0, count - 1, ...pinnedRows, ...[...nativeWindow.retained, ...mountWindow.selected].flatMap(key => { const index = nativeWindow.indices.get(key); return index === undefined ? [] : [index] })]) : undefined
  const cacheSlots = process.env.KYBERN_TRANSCRIPT_SLOT_CACHE !== '0'
  const windowed = process.env.KYBERN_TRANSCRIPT_WINDOW !== '0'
  useEffect(() => {
    if (!windowIndices) return
    const active = new Set(windowIndices.flatMap(index => logicalKeys[index] ? [logicalKeys[index]!] : []))
    for (const key of slotCache.keys()) if (!active.has(key)) slotCache.delete(key)
  }, [sparse, mountWindow.range.start, mountWindow.range.end, nativeWindow.retained, rowKeys])
  const restored = useRef<string | null>(null)
  const snapshot = useRef({ threadId, rowKeys, atTail, codeState })
  snapshot.current = { threadId, rowKeys, atTail, codeState }
  useEffect(() => subscribe(() => {
    const old = snapshot.current
    if (!old.threadId || pane.get().selectedId === old.threadId || !list.current) return
    const anchor = renderer.getListScrollTop?.(list.current.id)
    if (!anchor || !old.rowKeys.length) return
    scrollAnchors.delete(`${pane.id}:${old.threadId}`)
    scrollAnchors.set(`${pane.id}:${old.threadId}`, { key: old.rowKeys[Math.max(0, anchor[0]! - 1)] ?? old.rowKeys[0]!, offset: anchor[1]!, tail: old.atTail, code: old.codeState })
    if (scrollAnchors.size > 100) scrollAnchors.delete(scrollAnchors.keys().next().value!)
    restored.current = null
  }), [renderer, pane])
  useLayoutEffect(() => {
    const node = list.current
    return () => {
      const current = snapshot.current
      if (pane.frozen || !node || !current.threadId || !current.rowKeys.length) return
      const anchor = renderer.getListScrollTop?.(node.id)
      if (anchor) scrollAnchors.set(`${pane.id}:${current.threadId}`, { key: current.rowKeys[Math.max(0, anchor[0]! - 1)] ?? current.rowKeys[0]!, offset: anchor[1]!, tail: current.atTail, code: current.codeState })
    }
  }, [renderer, pane, loaded])
  useLayoutEffect(() => {
    if (!threadId || !loaded || !list.current || restored.current === threadId) return
    const saved = scrollAnchors.get(`${pane.id}:${threadId}`)
    if (!saved || saved.tail) { restored.current = threadId; return }
    if (codeState !== saved.code) return
    const index = rowKeys.indexOf(saved.key)
    if (!pane.frozen && index < 0 && hasEarlier && !loadingEarlier && !earlierError) { void loadEarlier(pane.id); return }
    restored.current = threadId
    mountWindow.reveal(Math.max(0, index))
    renderer.scrollToItem?.(list.current.id, Math.max(0, index) + 1, saved.offset)
    setAtTail(false)
    setActiveId(rows[Math.max(0, index)]?.turn.user?.id ?? null)
  }, [threadId, loaded, rowKeys, codeState, hasEarlier, loadingEarlier, earlierError, renderer])

  // Keep the reader's place when an older page is inserted above: read the list's
  // anchor before the commit, then shift it by the number of new turns.
  const firstKey = rowKeys[0] ?? ''
  const previous = useRef<{ threadId: string | null; firstKey: string; keys: string[]; lead: number } | null>(null)
  const pendingAnchor = useRef<{ index: number; offset: number } | null>(null)
  if (previous.current?.threadId === threadId && previous.current.firstKey && previous.current.firstKey !== firstKey && list.current) {
    const shift = rowKeys.indexOf(previous.current!.firstKey)
    const anchor = renderer.getListScrollTop?.(list.current.id)
    if (shift > 0 && anchor) pendingAnchor.current = { index: anchor[0]! - previous.current.lead + lead + shift, offset: anchor[1]! }
  }
  previous.current = { threadId, firstKey, keys: rowKeys, lead }
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current
    if (!anchor || !list.current) return
    pendingAnchor.current = null
    renderer.scrollToItem?.(list.current.id, anchor.index, anchor.offset)
  }, [firstKey, renderer])

  // A message the reader just sent brings the tail back into view (`followKey`).
  const latestUser = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.user) return turns[i]!.user!.id
    return null
  }, [turns])
  const seenUser = useRef(latestUser)
  const seenThread = useRef(threadId)
  useEffect(() => {
    // Another thread: its newest message is not "just sent".
    if (seenThread.current !== threadId) {
      seenThread.current = threadId
      seenUser.current = latestUser
      return
    }
    if (seenUser.current === latestUser) return
    const fresh = seenUser.current !== null
    seenUser.current = latestUser
    if (fresh && list.current) {
      mountWindow.reveal(rows.length)
      renderer.scrollToItem?.(list.current.id, count)
      setAtTail(true)
      setActiveId(turns.at(-1)?.user?.id ?? null)
    }
  }, [latestUser, count, renderer, threadId])

  // The destination body now mounts asynchronously. Bind observers after that
  // commit, by instance id (split/frozen panes may repeat message test ids).
  useEffect(() => {
    if(!jump || !list.current) return
    const {id,index} = jump, nodes = turnNodes.current.get(id)
    if(!nodes?.row || !nodes.user) return
    const target = list.current.id
    const rects: Record<string, LayoutRect | null> = {}
    // `scrollToItem` redraws at once and that reports new bounds: place from a deferred call, at most
    // three times, and stop once the offset stops changing, or the observer would chase its own scroll.
    let placed: number | null = null
    let attempts = 0
    let queued: ReturnType<typeof setTimeout> | undefined
    const place = () => {
      if (!paneHeight || attempts >= 3 || queued) return
      queued = setTimeout(() => {
        queued = undefined
        // Bounds arrive one host at a time. Read both after the batch,
        // never capture one fresh rect with the other host's old position.
        const { row, user } = rects
        if (!row || !user) return
        const bubble = user.height - 16
        const offset = Math.round(user.y - row.y - (paneHeight - bubble) / 2)
        if (offset === placed) return
        placed = offset
        attempts++
        renderer.scrollToItem?.(target, index + lead, offset)
      }, 0)
    }
    const stops = (['row', 'user'] as const).map(key => observeElementBounds(renderer, nodes[key]!.id, event => { rects[key] = event.rect; place() }))
    const timer = setTimeout(() => stop(), 1500)
    const stop = () => { clearTimeout(timer); clearTimeout(queued); stops.forEach(s => s()); jumpStop.current = null }
    jumpStop.current = stop
    return stop
  }, [jump, renderer, paneHeight])

  if (!loaded)
    return (
      <div testId="transcript-loading" style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
        {/* `chat-mount-loader-in`: a quick load never flashes the loader (200 ms fade after 150 ms). */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: REDUCED_MOTION ? 0 : 0.2, delay: 0.15, ease: 'easeOut' }} style={{ display: 'flex' }}>
          <MatrixLoader />
        </motion.div>
      </div>
    )

  if (turns.length === 0)
    return (
      <div testId="transcript-empty" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', paddingTop: 16 }}>
        {thread?.subagent && <div style={{ width: '100%', maxWidth: 750, paddingLeft: 24, paddingRight: 24 }}><SubagentDivider thread={thread} /></div>}
        <Label color={muted(t, 0.3)}>{thread?.subagent ? 'Waiting for the first message.' : 'Send a message to start the conversation.'}</Label>
      </div>
    )

  // `count` is gpui's at-end sentinel: the list's last pixel, not the last item's top.
  const scrollToBottom = () => {
    if (!list.current) return
    mountWindow.reveal(rows.length)
    renderer.scrollToItem?.(list.current.id, count)
    // A programmatic jump reports no new visible range, so update both states here.
    setAtTail(true)
    setActiveId(turns.at(-1)?.user?.id ?? null)
  }

  return (
    <TranscriptRowStateScope.Provider value={rowStateScope}><SparseRetention.Provider value={nativeWindow.context}><div ref={surfaceRef} testId="transcript-surface" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <virtual-list
        {...TRANSCRIPT_SCROLL_LAYOUT}
        {...(sparse ? { estimatedItemHeight: 160, itemCount: count, windowStart: windowIndices?.[0] ?? 0, windowIndices, ...nativeWindow.props } : { estimatedItemHeight: 160 })}
        ref={listRef}
        testId="transcript"
        alignment="top"
        followTail
        overdraw={Number(process.env.KYBERN_OVERDRAW ?? 512)}
        style={{ flexGrow: 1, minHeight: 0 }}
        onVisibleRange={(event) => {
          const start = event.startIndex ?? 0
          const end = event.endIndex ?? count
          mountWindow.onRange(Math.max(0, start - lead), Math.min(rows.length, end - lead))
          // The reader's place: the first or last prompt at either end, else the row mid-screen (`MessageScroller.activeId`).
          const tail = end >= count
          if (tail !== atTail) setAtTail(tail)
          // Prefetch while the first turns are on screen (`useEarlierHistory`).
          const top = start <= lead + 1
          if (!pane.frozen && top && !nearTop.current && !earlierError && pane.get().open.nextBeforeSeq != null && !pane.get().open.loadingEarlier) void loadEarlier(pane.id)
          nearTop.current = top
        }}
      >
        {[
          ...(hasEarlier
            ? [
                <Row key="__earlier">
                  <div testId="earlier-status" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, paddingTop: 8, paddingBottom: 8 }}>
                    {earlierError ? (
                      <>
                        <Label color={muted(t)} truncate style={{ flexShrink: 1 }}>{`Unable to load earlier messages. ${earlierError}`}</Label>
                        <div onClick={() => void loadEarlier(pane.id)} style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 6, backgroundColor: t.buttonSecondary, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
                          <Label color={t.text} weight={500}>Retry</Label>
                        </div>
                      </>
                    ) : (
                      <Label color={muted(t)}>{loadingEarlier ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}</Label>
                    )}
                  </div>
                </Row>,
              ]
            : [<div key="__top" ref={topRef} testId={`transcript-top:${pane.id}`} style={{ height: 16 }} />]),
          ...(windowIndices ? windowIndices.filter(i => i > 0 && i < count - 1).map(i => i - 1) : rows.map((_,i) => i)).map(index => {
            const row = rows[index]!
            const height = mountWindow.height(row.key, row.estimate)
            const mounted = sparse || !windowed || ((freshUntil.get(row.turn) ?? 0) > now && (freshUntil.get(row.turn) ?? 0) < now + 6000) || mountWindow.selected.has(row.key) || row.turn.running || (threadRunning && row.turn === turns.at(-1)) || (index >= mountWindow.range.start && index < mountWindow.range.end)
            const cached = cacheSlots ? slotCache.get(row.key) : undefined
            if(cached?.mounted === mounted && cached.height === height && cached.node === row.node) return cached.element
            const element = <TranscriptSlot key={row.key} rowKey={row.key} height={height} mounted={mounted} measure={mountWindow.measure} sync={mountWindow.sync}>{row.node}</TranscriptSlot>
            if(cacheSlots) slotCache.set(row.key, {mounted, height, node:row.node, element})
            return element
          }),
          <div key="__bottom" ref={bottomRef} testId={`transcript-bottom:${pane.id}`} style={{ height: COMPOSER_INSET + panelHeight }} />,
        ]}
      </virtual-list>
      {overflow && <MessageRail items={railItems} active={activeId} height={paneHeight} bottomInset={COMPOSER_INSET - 64 + panelHeight} onJump={(id) => {
        const index = rows.findIndex(row => row.turn.user?.id === id)
        if (index < 0 || !list.current) return
        setAtTail(false)
        setActiveId(id)
        // The desktop brings the prompt to the middle of the viewport (`navigationModel.scrollToItem`).
        // Mount the turn first, then place it from its measured row and bubble, whatever is scrolled now.
        jumpStop.current?.()
        const target = list.current.id
        mountWindow.reveal(index)
        renderer.scrollToItem?.(target, index + lead, 0)
        setJump(old => ({id,index,generation:(old?.generation ?? 0)+1}))
      }} />}
      {actionError && (
        <div style={{ position: 'absolute', top: 12, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.popover, maxWidth: 480 }}>
            <Para color={t.text} size={13} lineHeight={19.5}>{actionError}</Para>
          </div>
        </div>
      )}
      <ScrollToBottom visible={!atTail} bottom={COMPOSER_INSET - 64 + 24 + panelHeight} onClick={scrollToBottom} />
    </div></SparseRetention.Provider></TranscriptRowStateScope.Provider>
  )
}

/** The centred chat column (`ROW`: 736px, no inset of its own). */
function Row({ children }: { children: React.ReactNode }) {
  const gutter = usePaneCompact() ? 20 : GUTTER
  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingLeft: gutter, paddingRight: gutter }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, width: '100%', minWidth: 0, maxWidth: COLUMN }}>{children}</div>
    </div>
  )
}

const TurnItem = memo(function TurnItem({ turn, threadId, isLast, threadRunning, dateAt, nodes }: { turn: TurnGroup; threadId: string; isLast: boolean; threadRunning: boolean; dateAt: string | null; nodes: TurnNodes }) {
  const id = turn.user?.id
  const attach = useCallback((key: 'row' | 'user', node: PublicInstance | null) => {
    if(!id) return
    const entry = nodes.get(id) ?? {}
    entry[key] = node
    if(entry.row || entry.user) nodes.set(id, entry)
    else nodes.delete(id)
  }, [nodes, id])
  const rowRef = useCallback((node: PublicInstance | null) => attach('row', node), [attach])
  const userRef = useCallback((node: PublicInstance | null) => attach('user', node), [attach])
  return (
    <Row>
      <div ref={rowRef} testId={turn.user ? `turn-row:${turn.user.id}` : undefined} style={{ display: 'flex', flexDirection: 'column' }}>
        {dateAt && <DateSeparator at={dateAt} />}
        <Turn userRef={userRef} group={turn} threadId={threadId} isLast={isLast} threadRunning={isLast && threadRunning} />
      </div>
    </Row>
  )
})

/** 32px round button with an arrow (`size-8 rounded-full border bg-elevated-primary-opaque`).
 *  The desktop moves it between `translate-y-0 opacity-100` and `-translate-y-1
 *  scale-95 opacity-0 blur-[2px]` over `--duration-fast` / `--ease-smooth-out`,
 *  both ways. GPUIX keeps the fade and the 4px drift (hidden sits 4px higher)
 *  and drops scale and blur; Reduce Motion keeps only the fade. */
export function ScrollToBottom({ visible, bottom, onClick }: { visible: boolean; bottom: number; onClick: () => void }) {
  const t = useTheme()
  const [mounted, setMounted] = useState(visible)
  if (visible && !mounted) setMounted(true)
  if (!mounted) return null
  const hidden = bottom + (REDUCED_MOTION ? 0 : DISTANCE.micro)
  return (
    <motion.div
      initial={{ opacity: 0, bottom: hidden }}
      animate={{ opacity: visible ? 1 : 0, bottom: visible ? bottom : hidden }}
      transition={{ duration: REDUCED_MOTION ? DURATION.quick : DURATION.fast, ease: [...EASE.smoothOut] as [number, number, number, number] }}
      onMotionComplete={() => {
        if (!visible) setMounted(false)
      }}
      style={{ position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}
    >
      <div
        testId="scroll-to-bottom"
        role="button"
        aria-label="Scroll to bottom"
        onClick={visible ? onClick : undefined}
        style={{
          display: 'flex',
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.v('--color-background-elevated-primary-opaque'),
          cursor: 'pointer',
          pointerEvents: visible ? 'auto' : 'none',
          boxShadow: { offsetX: 0, offsetY: 2, blurRadius: 8, spreadRadius: -2, color: alpha('#000000', t.variant === 'dark' ? 0.4 : 0.12) },
          hover: { backgroundColor: over(t.v('--color-background-elevated-secondary'), t.surface) },
        }}
      >
        <Icon source={T.arrowDown} size={14} color={t.text} />
      </div>
    </motion.div>
  )
}
