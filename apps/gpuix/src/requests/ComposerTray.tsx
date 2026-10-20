// The composer tray: one surface above the composer for everything running beside the turn — the turn's subagents,
// background tasks, helper threads and queued follow-ups — with one summary line that opens and closes it. It replaces the
// separate subagent strip, runtime activity strip, helper panel and queued card, so they no longer stack card on card.
// Wording, order and the default open state are shared rules (`packages/kybern-client/src/composerTray.ts`).
//
// Motion (all on the P0 helpers): the body opens and closes with `Collapse` and the chevron turns with it (a keyboard toggle
// is instant); a row that arrives rises in (`Rise`, fresh rows only); a removed or sent queued row lifts out and closes up
// (`Leave`); a subagent that settles cross-swaps its loader for a check or alert and dims to the finished ink (`Dim`, 150 ms,
// paint-only); a changed count in the summary swaps in place (`SwapOnChange`). Reduce Motion: fades, or nothing.
import { createContext, memo, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { QueuedMessage, RuntimeTask, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { commandSummary, queuedPreview, trayDefaultOpen, traySummary, type TrayCounts } from '../../../../packages/kybern-client/src/composerTray.ts'
import { stoppableSubagents, subagentCounts, subagentDetail, subagentSpan, subagentThreadPhase, subagentTypeLabel, type SubagentPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { G } from '../composer/glyphs.ts'
import { Dim, Leave, useLeavingList } from '../composer/motion.tsx'
import { removeQueued } from '../composer/store.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { Collapse, Rise, SwapOnChange, revealTransform } from '../motion/kit.tsx'
import { openThread } from '../nav/history.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Elapsed } from '../subagents/Elapsed.tsx'
import { SubagentHover } from '../subagents/Hover.tsx'
import { FONT_MONO } from '../theme.ts'
import { T } from '../transcript/glyphs.ts'
import { reportError } from '../transcript/store.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { controlSubagent, showDock } from './Activity.tsx'

/** Row height; the body scrolls past `MAX_ROWS` (a half row peeks under the edge). */
const ROW = 28
const MAX_ROWS = 7
/** Space between the groups (subagents, tasks, helpers, queue): space, not lines, separates them. */
const GROUP_GAP = 6
/** The reader's open/closed choice per thread, for this session. */
const chosen = new Map<string, boolean>()

export interface TrayData {
  threadId: string
  subagents: readonly Thread[]
  tasks: readonly RuntimeTask[]
  helpers: readonly Thread[]
  queued: readonly QueuedMessage[]
}

export function trayCounts({ subagents, tasks, helpers, queued }: Omit<TrayData, 'threadId'>): TrayCounts {
  return {
    subagents: subagentCounts(subagents.map(subagentThreadPhase)),
    tasks: tasks.length,
    helpers: { total: helpers.length, working: helpers.filter(c => c.status === 'running').length, approval: helpers.filter(c => c.status === 'awaiting-approval').length },
    queued: queued.length,
  }
}

export const trayVisible = (d: Omit<TrayData, 'threadId'>) => d.subagents.length + d.tasks.length + d.helpers.length + d.queued.length > 0

/** `divided`: a request card follows in the same surface, so the tray ends with a hairline instead of running into the composer. */
export function ComposerTray({ data, divided = false }: { data: TrayData; divided?: boolean }) {
  const t = useTheme()
  const { threadId, subagents, tasks, helpers, queued } = data
  const counts = trayCounts(data)
  const rows = subagents.length + tasks.length + helpers.length + queued.length
  const [defaultOpen] = useState(() => trayDefaultOpen(counts, rows))
  const [open, setOpen] = useState(() => chosen.get(threadId) ?? defaultOpen)
  // A keyboard toggle shows its end state at once; a pointer toggle animates.
  const [keyboard, setKeyboard] = useState(false)
  const toggle = (viaKeyboard: boolean) => { chosen.set(threadId, !open); setKeyboard(viaKeyboard); setOpen(!open) }
  const scroll = rows > MAX_ROWS
  const body = <TrayBody data={data} scroll={scroll} />
  return (
    <div testId="composer-tray" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...(divided ? { borderBottomWidth: 1, borderColor: t.borderLight } : {}) }}>
      <TrayHeader counts={counts} subagents={subagents} tasks={tasks} open={open} onToggle={toggle} />
      {keyboard ? (open ? body : null) : <Collapse open={open}>{body}</Collapse>}
    </div>
  )
}

function TrayHeader({ counts, subagents, tasks, open, onToggle }: { counts: TrayCounts; subagents: readonly Thread[]; tasks: readonly RuntimeTask[]; open: boolean; onToggle: (keyboard: boolean) => void }) {
  const t = useTheme()
  const segments = traySummary(counts)
  const stoppable = stoppableSubagents(subagents)
  const working = counts.subagents.working > 0 || tasks.length > 0 || counts.helpers.working > 0
  const state = working ? 'working' : counts.subagents.failed > 0 ? 'failed' : counts.subagents.done + counts.subagents.stopped > 0 ? 'done' : 'queued'
  const label = segments.map(s => s.text).join(', ')
  const toggle = () => onToggle(false)
  return (
    // "Stop all" sits between the summary and the chevron but outside the toggle: GPUIX clicks bubble, and a stop must not
    // also close the tray. The summary is the focusable toggle; the chevron is a second pointer target for the same toggle.
    <div style={{ display: 'flex', alignItems: 'center', height: 36, minWidth: 0 }}>
      <div
        testId="composer-tray-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${label}. ${open ? 'Hide' : 'Show'} details`}
        onClick={toggle}
        onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onToggle(true) }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, paddingLeft: 14, paddingRight: 8, cursor: 'pointer', flexGrow: 1, flexShrink: 1, minWidth: 0 }}
      >
        <StatusGlyph phase={state} />
        {/* The whole line swaps as one (`TextSwap`): swapping a single segment would slide its neighbours under the outgoing copy. */}
        <SwapOnChange active={label} style={{ justifyContent: 'flex-start', flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            {segments.map((s, i) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', flexShrink: i === 0 ? 1 : 0, minWidth: i === 0 ? 0 : undefined }}>
                {i > 0 && <Label color={ink(t, 0.3)} size={12} lineHeight={16} style={{ paddingLeft: 5, paddingRight: 5 }}>·</Label>}
                <Label color={s.tone === 'failed' ? t.red : s.tone === 'lead' ? ink(t, 0.85) : ink(t, 0.55)} size={12} lineHeight={16} weight={500} truncate>{s.text}</Label>
              </div>
            ))}
          </div>
        </SwapOnChange>
      </div>
      {open && stoppable.length >= 2 && <HeaderButton testId="subagents-stop-all" onClick={() => { for (const child of stoppable) void controlSubagent(child, 'stop') }}>Stop all</HeaderButton>}
      <div testId="composer-tray-chevron" onClick={toggle} style={{ display: 'flex', alignItems: 'center', height: 36, paddingLeft: 8, paddingRight: 8, flexShrink: 0, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20 }}>
          <Chevron open={open} source={T.chevronDown} turn={180} size={12} color={ink(t, 0.45)} />
        </div>
      </div>
    </div>
  )
}

function HeaderButton({ children, onClick, testId }: { children: string; onClick: () => void; testId: string }) {
  const t = useTheme()
  return (
    <div testId={testId} role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onClick() }}
      style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 8, flexShrink: 0, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
      <Label color={ink(t, 0.7)} size={12} weight={500}>{children}</Label>
    </div>
  )
}

/** Loader while working, then a check, an alert or a stop square; the change cross-swaps (`IconSwap`), the first state paints still. */
function StatusGlyph({ phase }: { phase: SubagentPhase | 'queued' }) {
  const t = useTheme()
  return (
    <SwapOnChange kind="icon" active={phase} style={{ width: 16, height: 16, flexShrink: 0 }}>
      {phase === 'working' ? <MatrixLoader />
        : phase === 'failed' ? <Icon source={T.alert} size={14} color={t.red} />
        : phase === 'stopped' ? <Icon source={G.stop} size={9} color={ink(t, 0.45)} />
        : phase === 'queued' ? <Icon source={G.clock} size={14} color={ink(t, 0.5)} />
        : <Icon source={T.check} size={14} color={ink(t, 0.45)} />}
    </SwapOnChange>
  )
}

function TrayBody({ data, scroll }: { data: TrayData; scroll: boolean }) {
  const { threadId, subagents, tasks, helpers, queued } = data
  // Queued rows keep their last frame to leave (removed by hand, or sent when the turn ends); the others just go.
  const [entries, gone] = useLeavingList(queued)
  const freshSubagents = useFreshIds(subagents)
  const freshTasks = useFreshIds(tasks)
  const groups: ReactNode[][] = [
    subagents.map(child => <Rise key={child.id} kind="row" play={freshSubagents(child.id)}><SubagentRow thread={child} /></Rise>),
    tasks.map(task => <Rise key={task.id} kind="row" play={freshTasks(task.id)}><TaskRow task={task} threadId={threadId} /></Rise>),
    helpers.map(child => <HelperRow key={child.id} thread={child} />),
    entries.map(({ item, leaving, fresh }) => leaving
      ? <Leave key={item.id} height={ROW} onDone={() => gone(item.id)}><QueuedRow item={item} threadId={threadId} /></Leave>
      : <Rise key={item.id} kind="row" play={fresh}><QueuedRow item={item} threadId={threadId} /></Rise>),
  ].filter(group => group.length > 0)
  if (scroll) {
    // Past seven rows: one virtual list (no nested scrollers), group gaps as row padding, no enter/leave motion.
    const flat = groups.flatMap((group, g) => group.map((row, i) => ({ row, gap: g > 0 && i === 0 })))
    // Seven and a half rows plus the gaps above them: the half row under the edge says the list goes on.
    const height = (MAX_ROWS + 0.5) * ROW + Math.min(groups.length - 1, MAX_ROWS) * GROUP_GAP
    return (
      <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
        <virtual-list testId="composer-tray-list" style={{ width: '100%', height }}>
          {flat.map(({ row, gap }) => <div key={(row as { key: string }).key} style={{ display: 'flex', flexDirection: 'column', paddingLeft: 8, paddingRight: 8, paddingTop: gap ? GROUP_GAP : 0 }}>{row}</div>)}
        </virtual-list>
      </div>
    )
  }
  return (
    <div testId="composer-tray-body" style={{ display: 'flex', flexDirection: 'column', gap: GROUP_GAP, paddingLeft: 8, paddingRight: 8, paddingBottom: 6 }}>
      {groups.map((group, i) => <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>{group}</div>)}
    </div>
  )
}

/** Ids present at the first render are not fresh: only rows that arrive later rise in (initial loads do not animate). */
function useFreshIds(items: readonly { id: string }[]) {
  const initial = useRef<Set<string> | null>(null)
  initial.current ??= new Set(items.map(item => item.id))
  return (id: string) => !initial.current!.has(id)
}

/** A row's focus reporter. GPUIX focus events do not bubble, so the row's own `onFocus` never sees Tab landing on its
 *  open target or actions; they report here instead (focus-within). */
const RowFocus = createContext<((focused: boolean) => void) | null>(null)
function useRowFocus() {
  const report = useContext(RowFocus)
  return report ? { onFocus: () => report(true), onBlur: () => report(false) } : {}
}

/** The shared row frame: a 16px glyph column, the text, and a right column that trades its value for actions on hover or
 *  keyboard focus. */
function Row({ glyph, children, trailing, actions, onOpen, testId, hoverable = true }: { glyph: ReactNode; children: ReactNode; trailing?: ReactNode; actions?: ReactNode; onOpen?: () => void; testId?: string; hoverable?: boolean }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  // Focused children, counted: Tab from one action to the next may focus the new one before blurring the old.
  const focusCount = useRef(0)
  const [focused, setFocused] = useState(false)
  const report = useMemo(() => (on: boolean) => { focusCount.current = Math.max(0, focusCount.current + (on ? 1 : -1)); setFocused(focusCount.current > 0) }, [])
  const reveal = !!actions && (hover || focused)
  return (
    <RowFocus.Provider value={report}>
      <div
        testId={testId}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW, paddingLeft: 6, paddingRight: 4, borderRadius: 8, minWidth: 0, backgroundColor: hover && hoverable ? t.buttonSecondaryHover : 'transparent' }}
      >
        <div
          role={onOpen ? 'button' : undefined}
          tabIndex={onOpen ? 0 : undefined}
          onFocus={onOpen ? () => report(true) : undefined}
          onBlur={onOpen ? () => report(false) : undefined}
          onClick={onOpen}
          onKeyDown={onOpen ? e => { if (e.key === 'enter' || e.key === 'space') onOpen() } : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, height: ROW, cursor: onOpen ? 'pointer' : 'default' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0 }}>{glyph}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0, overflow: 'hidden' }}>{children}</div>
        </div>
        {(trailing || actions) && (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minWidth: 52, height: ROW, paddingLeft: 4, paddingRight: 2, flexShrink: 0 }}>
            {/* The value and the actions trade places on hover or focus (`t-reveal`: 150 ms in with a 4 px slide, 100 ms out). */}
            <div paintTransform={actions ? revealTransform(!reveal, false) : undefined} style={{ display: 'flex', ...(PATCHED_NATIVE || !actions ? {} : { opacity: reveal ? 0 : 1 }), ...(actions ? { pointerEvents: 'none' } : {}) }}>{trailing}</div>
            {actions && (
              <div paintTransform={revealTransform(reveal)} style={{ position: 'absolute', right: 0, top: 3, display: 'flex', gap: 2, ...(PATCHED_NATIVE ? {} : { opacity: reveal ? 1 : 0 }), pointerEvents: reveal ? undefined : 'none' }}>
                {actions}
              </div>
            )}
          </div>
        )}
      </div>
    </RowFocus.Provider>
  )
}

/** `keep`: the title holds up to 70% of the row before a long detail beside it gives way. */
function Title({ children, mono = false, keep = false, testId }: { children: string; mono?: boolean; keep?: boolean; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', flexShrink: keep ? 0 : 1, minWidth: 0, ...(keep ? { maxWidth: '70%' } : {}) }}><Label color={ink(t, mono ? 0.8 : 0.88)} size={mono ? 12 : 13} lineHeight={18} font={mono ? FONT_MONO : undefined} truncate>{children}</Label></div>
}
function Meta({ children, color, shrink = false }: { children: string; color?: string; shrink?: boolean }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexShrink: shrink ? 1 : 0, minWidth: 0, maxWidth: shrink ? undefined : '45%' }}><Label color={color ?? ink(t, 0.42)} size={13} lineHeight={18} truncate>{children}</Label></div>
}
function Clock({ startedAt, endedAt }: { startedAt: number; endedAt: number | null }) {
  const t = useTheme()
  return <Elapsed startedAt={startedAt} endedAt={endedAt} size={12} tabular color={ink(t, 0.42)} />
}
function IconAction({ label, glyph, size = 12, onClick, testId }: { label: string; glyph: string; size?: number; onClick: () => void; testId: string }) {
  const t = useTheme()
  const focus = useRowFocus()
  return (
    <div testId={testId} role="button" aria-label={label} tabIndex={0} {...focus} onClick={onClick} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onClick() }}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
      <Icon source={glyph} size={size} color={ink(t, 0.48)} />
    </div>
  )
}

const SubagentRow = memo(function SubagentRow({ thread }: { thread: Thread }) {
  const t = useTheme()
  const phase = subagentThreadPhase(thread), info = thread.subagent!
  const span = subagentSpan(thread)
  const failure = phase === 'failed' ? subagentDetail(thread) : null
  const type = subagentTypeLabel(info.agent_type)
  const canBackground = phase === 'working' && info.capabilities?.background === true && !info.backgrounded
  const canStop = phase === 'working' && info.capabilities?.stop !== false
  const actions = canBackground || canStop ? <>
    {canBackground && <IconAction testId={`subagent-background-${thread.id}`} label={`Run ${thread.title || 'subagent'} in background`} glyph={G.background} size={13} onClick={() => void controlSubagent(thread, 'background')} />}
    {canStop && <IconAction testId={`subagent-stop-${thread.id}`} label={`Stop ${thread.title || 'subagent'}`} glyph={G.stop} size={9} onClick={() => void controlSubagent(thread, 'stop')} />}
  </> : undefined
  return (
    // Finished and stopped rows settle to the quieter ink (150 ms fade, paint-only); working and failed rows stay at full.
    <Dim dimmed={phase === 'done' || phase === 'stopped'} level={0.7}>
      <SubagentHover thread={thread}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <Row testId={`subagent-open-${thread.id}`} onOpen={() => openThread(thread.id)} glyph={<StatusGlyph phase={phase} />} actions={actions} trailing={span && <Clock startedAt={span.startedAt} endedAt={span.endedAt} />}>
            <Title keep={!!failure}>{thread.title || 'Subagent'}</Title>
            {failure ? <Meta color={t.red} shrink>{failure.text}</Meta> : type && <Meta>{type}</Meta>}
          </Row>
        </div>
      </SubagentHover>
    </Dim>
  )
})

const TaskRow = memo(function TaskRow({ task, threadId }: { task: RuntimeTask; threadId: string }) {
  const t = useTheme()
  const process = task.kind === 'process'
  const summary = process ? commandSummary(task.title) : { text: task.title, folder: null }
  const started = Date.parse(task.started_at)
  return (
    <Row testId={`runtime-task-${task.id}`} onOpen={() => showDock(threadId, 'activity')} glyph={<Icon source={process ? G.terminal : task.kind === 'agent' ? T.robot : G.workflow} size={14} color={ink(t, 0.5)} />}
      trailing={Number.isFinite(started) ? <Clock startedAt={started} endedAt={null} /> : undefined}>
      <Title mono={process}>{summary.text || 'Background task'}</Title>
      {summary.folder && <Meta>{`in ${summary.folder}`}</Meta>}
    </Row>
  )
})

const HelperRow = memo(function HelperRow({ thread }: { thread: Thread }) {
  const t = useTheme()
  const approval = thread.status === 'awaiting-approval'
  const amber = t.variant === 'dark' ? '#fcd34d' : '#d97706'
  return (
    <Row testId={`helper-${thread.id}`} onOpen={() => openThread(thread.id)}
      glyph={thread.status === 'running' ? <MatrixLoader /> : approval ? <Icon source={G.hand} size={14} color={amber} /> : thread.status === 'failed' ? <Icon source={T.alert} size={14} color={t.red} /> : <Icon source={T.check} size={14} color={ink(t, 0.45)} />}>
      <Title>{thread.title || 'Untitled'}</Title>
      <Meta color={approval ? amber : thread.status === 'failed' ? t.red : undefined}>{thread.status === 'running' ? 'Helper' : approval ? 'Needs approval' : thread.status === 'failed' ? 'Failed' : 'Helper · idle'}</Meta>
    </Row>
  )
})

const QueuedRow = memo(function QueuedRow({ item, threadId }: { item: QueuedMessage; threadId: string }) {
  const t = useTheme()
  const preview = queuedPreview(item.message)
  const thumb = preview.images[0]
  const outline = ink(t, 0.1)
  const remove = () => void removeQueued(threadId, item.id).catch(e => reportError('Unable to remove follow-up', e))
  return (
    <Row testId={`queued-${item.id}`} hoverable={false}
      glyph={thumb && preview.imagesOnly
        ? <img src={thumb} objectFit="cover" style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: outline }} />
        : <Icon source={preview.kind === 'update' ? G.workflow : G.clock} size={14} color={ink(t, 0.5)} />}
      trailing={<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {preview.imageCount > 0 && !preview.imagesOnly && <ImageCount count={preview.imageCount} thumb={thumb} />}
        <div testId={`queued-remove-${item.id}`} role="button" aria-label="Remove queued follow-up" tabIndex={0} onClick={remove} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') remove() }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <Icon source={G.x} size={12} color={ink(t, 0.38)} />
        </div>
      </div>}
    >
      <Title testId="queued-preview">{preview.text}</Title>
      {preview.detail && <Meta shrink>{preview.detail}</Meta>}
    </Row>
  )
})

function ImageCount({ count, thumb }: { count: number; thumb?: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, pointerEvents: 'none' }}>
      {thumb ? <img src={thumb} objectFit="cover" style={{ width: 14, height: 14, borderRadius: 3, borderWidth: 1, borderColor: ink(t, 0.1) }} /> : <Icon source={G.paperclip} size={12} color={ink(t, 0.45)} />}
      {count > 1 && <Label color={ink(t, 0.45)} size={12}>{`+${count - 1}`}</Label>}
    </div>
  )
}
