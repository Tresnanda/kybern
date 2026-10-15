// The thread transcript (`views/Transcript.tsx`): turns grouped by the shared
// `groupTurns`, rows centred at 736px inside 56px gutters, a date line where a
// day starts, a virtual list that follows the tail, earlier pages loaded when
// the top comes into view (reading position kept), and the 32px "Scroll to
// bottom" button while away from the tail. Rows live in `transcript/`.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { createTurnGrouper, type TurnGroup } from '../../../packages/kybern-client/src/transcript.ts'
import { calendarDateKey } from '../../desktop/src/lib/format.ts'
import { Icon } from './icons.tsx'
import { MatrixLoader } from './MatrixLoader.tsx'
import { getState, subscribe, useApp } from './state.ts'
import { Label, REDUCED_MOTION, useTheme } from './ui.tsx'
import { DISTANCE, DURATION, EASE } from './motion/kit.tsx'
import { CodeChunk, CodeHeader, markdownParts, Prose, textChunks } from './transcript/markdown.tsx'
import { MessageRail } from './transcript/rail.tsx'
import { longestLine, useCodeColumns } from './transcript/codeWidth.ts'
import { T } from './transcript/glyphs.ts'
import { alpha, muted, Para } from './transcript/kit.tsx'
import { over } from './theme.ts'
import { AnswerImages, DateSeparator, Turn, TurnFooter, turnTimestamp } from './transcript/Turn.tsx'
import { loadEarlier, resetRowState, useActionError, useEarlierError, usePacedBlocks, useRequestPanelHeight } from './transcript/store.ts'

export { markdownTheme } from './transcript/kit.tsx'

export const GUTTER = 56
export const COLUMN = 736
/** The floating composer's height plus 64 (`bottomInset + 64`, `Transcript.tsx:479`). */
const COMPOSER_INSET = 172
const turnKey = (group: TurnGroup, index: number) => group.turnId || group.user?.id || `turn-${index}`

type SavedAnchor = { key: string; offset: number; tail: boolean; code: Record<string, { expanded: boolean; wrap: boolean }> }
const scrollAnchors = new Map<string, SavedAnchor>()

export function Transcript() {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const threadId = useApp((s) => s.selectedId)
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
  const list = useRef<PublicInstance>(null)
  const [atTail, setAtTail] = useState(true)
  const [codeState, setCodeState] = useState<Record<string, { expanded: boolean; wrap: boolean }>>({})
  const [activeRow, setActiveRow] = useState(0)
  const codeColumns = useCodeColumns(threadId ?? null, GUTTER, COLUMN)
  const nearTop = useRef(false)

  useEffect(() => {
    resetRowState()
    setCodeState(threadId ? scrollAnchors.get(threadId)?.code ?? {} : {})
    setAtTail(threadId ? scrollAnchors.get(threadId)?.tail ?? true : true)
    nearTop.current = false
  }, [threadId])
  // Consume one top-entry intent per page. Prepending or a retry must not
  // recursively download every older page without another reading gesture.

  // Every answer block/chunk is a direct virtual-list item. Expanding a 5k
  // line fence never mounts 5k native rows, nor adds a nested scroller.
  const rows = useMemo(() => turns.flatMap((turn, i) => {
    const key = turnKey(turn, i)
    const at = turnTimestamp(turn)
    const startsDay = !!at && ((!hasEarlier && i === 0) || (i > 0 && calendarDateKey(at) !== calendarDateKey(turnTimestamp(turns[i - 1]!))))
    const running = turn.running || (i === turns.length - 1 && threadRunning && !turn.end)
    const result = [{ key, turn, node: <TurnItem turn={turn} threadId={threadId!} isLast={i === turns.length - 1} threadRunning={i === turns.length - 1 && threadRunning} dateAt={startsDay ? at : null} /> }]
    if (running) return result
    result.push({ key: `${key}:images`, turn, node: <Row><AnswerImages group={turn} threadId={threadId!} /></Row> })
    for (const part of markdownParts(turn.answer?.text ?? '')) {
      const partKey = `${key}:answer:${part.key}`
      const chunks = textChunks(part.text)
      if (part.kind === 'code') {
        // Wrap only when a line would be cut off; the Wrap button overrides either way.
        const state = codeState[partKey] ?? { expanded: false, wrap: longestLine(part.text) > codeColumns }
        const update = (patch: Partial<typeof state>) => setCodeState(value => ({ ...value, [partKey]: { ...state, ...patch } }))
        result.push({ key: partKey, turn, node: <Row><CodeHeader part={part} {...state} onWrap={() => update({ wrap: !state.wrap })} onExpand={chunks.length > 1 ? () => update({ expanded: !state.expanded }) : undefined} /></Row> })
        for (const [chunkIndex, chunk] of (state.expanded ? chunks : chunks.slice(0, 1)).entries()) {
          result.push({ key: `${partKey}:${chunkIndex}`, turn, node: <Row><CodeChunk text={chunk} language={part.language} wrap={state.wrap} /></Row> })
        }
        result.push({ key: `${partKey}:gap`, turn, node: <div style={{ height: 10 }} /> })
      } else {
        for (const [chunkIndex, chunk] of chunks.entries()) result.push({ key: `${partKey}:${chunkIndex}`, turn, node: <Row><Prose text={chunk} /></Row> })
      }
    }
    result.push({ key: `${key}:footer`, turn, node: <Row><TurnFooter group={turn} threadId={threadId!} isLast={i === turns.length - 1} /></Row> })
    return result
  }), [turns, hasEarlier, threadId, threadRunning, codeState, codeColumns])
  // A top spacer is present even without earlier history.
  const lead = 1
  const count = lead + rows.length + 1
  const rowKeys = useMemo(() => rows.map(row => row.key), [rows])
  const restored = useRef<string | null>(null)
  const snapshot = useRef({ threadId, rowKeys, atTail, codeState })
  snapshot.current = { threadId, rowKeys, atTail, codeState }
  useEffect(() => subscribe(() => {
    const old = snapshot.current
    if (!old.threadId || getState().selectedId === old.threadId || !list.current) return
    const anchor = renderer.getListScrollTop?.(list.current.id)
    if (!anchor || !old.rowKeys.length) return
    scrollAnchors.delete(old.threadId)
    scrollAnchors.set(old.threadId, { key: old.rowKeys[Math.max(0, anchor[0]! - 1)] ?? old.rowKeys[0]!, offset: anchor[1]!, tail: old.atTail, code: old.codeState })
    if (scrollAnchors.size > 100) scrollAnchors.delete(scrollAnchors.keys().next().value!)
    restored.current = null
  }), [renderer])
  useLayoutEffect(() => {
    if (!threadId || !loaded || !list.current || restored.current === threadId) return
    const saved = scrollAnchors.get(threadId)
    if (!saved || saved.tail) { restored.current = threadId; return }
    if (codeState !== saved.code) return
    const index = rowKeys.indexOf(saved.key)
    if (index < 0 && hasEarlier && !loadingEarlier && !earlierError) { void loadEarlier(); return }
    restored.current = threadId
    renderer.scrollToItem?.(list.current.id, Math.max(0, index) + 1, saved.offset)
    setAtTail(false)
    setActiveRow(Math.max(0, index))
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
      renderer.scrollToItem?.(list.current.id, count)
      setAtTail(true)
    }
  }, [latestUser, count, renderer, threadId])

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
      <div testId="transcript-empty" style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: COMPOSER_INSET - 64 }}>
        <Label color={muted(t, 0.3)}>Send a message to start the conversation.</Label>
      </div>
    )

  // `count` is gpui's at-end sentinel: the list's last pixel, not the last item's top.
  const scrollToBottom = () => {
    if (!list.current) return
    renderer.scrollToItem?.(list.current.id, count)
    // A programmatic jump reports no new visible range, so the tail state is set here.
    setAtTail(true)
  }

  return (
    <div testId="transcript-surface" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <virtual-list
        ref={list}
        testId="transcript"
        alignment="bottom"
        followTail
        estimatedItemHeight={160}
        overdraw={Number(process.env.KYBERN_OVERDRAW ?? 512)}
        style={{ flexGrow: 1, minHeight: 0 }}
        onVisibleRange={(event) => {
          const start = event.startIndex ?? 0
          const end = event.endIndex ?? count
          setActiveRow(Math.max(0, start - lead))
          const tail = end >= count
          if (tail !== atTail) setAtTail(tail)
          // Prefetch while the first turns are on screen (`useEarlierHistory`).
          const top = start <= lead + 1
          if (top && !nearTop.current && !earlierError && getState().open.nextBeforeSeq != null && !getState().open.loadingEarlier) void loadEarlier()
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
                        <div onClick={() => void loadEarlier()} style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 6, backgroundColor: t.buttonSecondary, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
                          <Label color={t.text} weight={500}>Retry</Label>
                        </div>
                      </>
                    ) : (
                      <Label color={muted(t)}>{loadingEarlier ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}</Label>
                    )}
                  </div>
                </Row>,
              ]
            : [<div key="__top" style={{ height: 16 }} />]),
          ...rows.map(row => <div key={row.key} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>{row.node}</div>),
          <div key="__bottom" style={{ height: COMPOSER_INSET + panelHeight }} />,
        ]}
      </virtual-list>
      <MessageRail turns={turns} active={rows[activeRow]?.turn.turnId ?? null} onJump={(id) => {
        const index = rows.findIndex(row => row.turn.turnId === id)
        if (index >= 0 && list.current) {
          renderer.scrollToItem?.(list.current.id, index + lead, 0)
          setAtTail(false)
          setActiveRow(index)
        }
      }} />
      {actionError && (
        <div style={{ position: 'absolute', top: 12, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.popover, maxWidth: 480 }}>
            <Para color={t.text} size={13} lineHeight={19.5}>{actionError}</Para>
          </div>
        </div>
      )}
      <ScrollToBottom visible={!atTail} bottom={COMPOSER_INSET - 64 + 24 + panelHeight} onClick={scrollToBottom} />
    </div>
  )
}

/** The centred chat column (`ROW`: 736px, no inset of its own). */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingLeft: GUTTER, paddingRight: GUTTER }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, width: '100%', minWidth: 0, maxWidth: COLUMN }}>{children}</div>
    </div>
  )
}

const TurnItem = memo(function TurnItem({ turn, threadId, isLast, threadRunning, dateAt }: { turn: TurnGroup; threadId: string; isLast: boolean; threadRunning: boolean; dateAt: string | null }) {
  return (
    <Row>
      {dateAt && <DateSeparator at={dateAt} />}
      <Turn group={turn} threadId={threadId} isLast={isLast} threadRunning={isLast && threadRunning} />
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
