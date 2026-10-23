// The composer tray: one surface above the composer for everything running beside the turn — the turn's subagents,
// background tasks, helper threads and queued follow-ups — with one summary line that opens and closes it. It replaces the
// separate subagent strip, runtime activity strip, helper panel and queued card, so they no longer stack card on card.
// Wording, order and the default open state are shared rules (`packages/kybern-client/src/composerTray.ts`).
//
// Inside, each kind of row has its own section under a label (`SectionLabel`, the `@` picker's): Subagents, Background tasks,
// Helpers, Queued. The subagents hang from a tree stem under their label (`../tree/`), in the glyph column the header's and
// the other sections' icons share.
//
// Motion (all on the P0 helpers): the body opens and closes with `Collapse` and the chevron turns with it (a keyboard toggle
// is instant); opening it by pointer draws the subagents' connectors in (`markTreeOpen`), closing draws them out; a row that
// arrives rises in (`Rise`, fresh rows only) and a section that appears rises in with its first row; a removed or sent queued
// row lifts out and closes up (`Leave`), and its label leaves with the last one; a subagent that settles cross-swaps its
// loader for a check or alert and dims to the finished ink (`Dim`, 150 ms, paint-only); a changed count in the summary swaps
// in place (`SwapOnChange`). Reduce Motion: fades, or nothing.
import { createContext, memo, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { QueuedMessage, RuntimeTask, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { commandSummary, queuedPreview, trayDefaultOpen, traySummary, type TrayCounts } from '../../../../packages/kybern-client/src/composerTray.ts'
import { stoppableSubagents, subagentCounts, subagentDetail, subagentSpan, subagentThreadPhase, subagentTypeLabel, type SubagentPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { G } from '../composer/glyphs.ts'
import { Dim, Leave, useLeavingList } from '../composer/motion.tsx'
import { SECTION_LABEL, SectionLabel } from '../composer/Menu.tsx'
import { removeQueued, STEERABLE, steerQueued } from '../composer/store.ts'
import { useApp } from '../state.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { Collapse, Rise, SwapOnChange, revealTransform } from '../motion/kit.tsx'
import { openThread } from '../nav/history.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Elapsed } from '../subagents/Elapsed.tsx'
import { SubagentHover } from '../subagents/Hover.tsx'
import { FONT_MONO } from '../theme.ts'
import { T } from '../transcript/glyphs.ts'
import { reportError } from '../transcript/store.ts'
import { markTreeOpen, TICK_GAP, TreeGroup, TreeItem, TreeLines, useTreeSlot, type TreeShape } from '../tree/Tree.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { controlSubagent, showDock } from './Activity.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'

/** Row height. The body scrolls once its rows and the labels after the first pass `MAX_ROWS` rows of height; a half row peeks
 *  under the edge. */
const ROW = 28
const MAX_ROWS = 7
/** The body's side padding and a row's own left padding: icons start 14px in, their column's centre is at 22. */
const BODY_PAD = 8
const ROW_PAD = 6
/** Subagent rows sit this far in, hanging from a stem in the icon column (the transcript's groups step in 22px too). */
const INDENT = 22
const STEM = BODY_PAD + ROW_PAD + 8
/** `TreeGroup` in a subagent row's coordinates (its left edge is BODY_PAD + INDENT in): the stem, and ticks stopping short of the icon. */
const SUBAGENT_TREE = { x: STEM - BODY_PAD - INDENT, tickEnd: ROW_PAD - TICK_GAP }
const labelHeight = (first: boolean) => (first ? SECTION_LABEL.firstTop : SECTION_LABEL.top) + SECTION_LABEL.line + SECTION_LABEL.bottom
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
  const toggle = (viaKeyboard: boolean) => {
    // A pointer open draws the subagents' connectors in with their rows; a keyboard toggle shows the end state.
    if (!open && !viaKeyboard) markTreeOpen()
    chosen.set(threadId, !open); setKeyboard(viaKeyboard); setOpen(!open)
  }
  const body = <TrayBody data={data} open={open} />
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
      {open && stoppable.length >= 2 && <Button size="sm" testId="subagents-stop-all" onClick={() => { for (const child of stoppable) void controlSubagent(child, 'stop') }}>Stop all</Button>}
      <div testId="composer-tray-chevron" onClick={toggle} style={{ display: 'flex', alignItems: 'center', height: 36, paddingLeft: 8, paddingRight: 8, flexShrink: 0, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20 }}>
          <Chevron open={open} source={T.chevronDown} turn={180} size={12} color={ink(t, 0.45)} />
        </div>
      </div>
    </div>
  )
}

/** Loader while working, then a check, an alert or a stop square; the change cross-swaps (`IconSwap`), the first state paints still. */
function StatusGlyph({ phase }: { phase: SubagentPhase | 'queued' }) {
  const t = useTheme()
  return (
    <SwapOnChange kind="icon" active={phase} style={{ width: 16, height: 16, flexShrink: 0 }}>
      {phase === 'working' ? <MatrixLoader whole />
        : phase === 'failed' ? <Icon source={T.alert} size={14} color={t.red} />
        : phase === 'stopped' ? <Icon source={G.stop} size={9} color={ink(t, 0.45)} />
        : phase === 'queued' ? <Icon source={G.clock} size={14} color={ink(t, 0.5)} />
        : <Icon source={T.check} size={14} color={ink(t, 0.45)} />}
    </SwapOnChange>
  )
}

type SectionKey = 'subagents' | 'tasks' | 'helpers' | 'queued'
const SECTION_NAME: Record<SectionKey, string> = { subagents: 'Subagents', tasks: 'Background tasks', helpers: 'Helpers', queued: 'Queued' }
interface TrayItem { key: string; node: ReactNode }
interface Section { key: SectionKey; rows: TrayItem[]; /** Every row is leaving: the label leaves with the last one. */ leaving: boolean }

function TrayBody({ data, open }: { data: TrayData; open: boolean }) {
  const { threadId, subagents, tasks, helpers, queued } = data
  // Queued rows keep their last frame to leave (removed by hand, or sent when the turn ends); the others just go.
  const [entries, gone] = useLeavingList(queued)
  const freshSubagents = useFreshIds(subagents)
  const freshTasks = useFreshIds(tasks)
  const all: Section[] = [
    { key: 'subagents', leaving: false, rows: subagents.map((child, i) => ({ key: child.id, node: (
      <Rise key={child.id} kind="row" play={freshSubagents(child.id)}>
        <TreeItem joint="node" last={i === subagents.length - 1} index={i} count={subagents.length} anchor={ROW / 2}>
          <SubagentRow thread={child} />
        </TreeItem>
      </Rise>
    ) })) },
    { key: 'tasks', leaving: false, rows: tasks.map(task => ({ key: task.id, node: <Rise key={task.id} kind="row" play={freshTasks(task.id)}><TaskRow task={task} threadId={threadId} /></Rise> })) },
    { key: 'helpers', leaving: false, rows: helpers.map(child => ({ key: child.id, node: <HelperRow key={child.id} thread={child} /> })) },
    { key: 'queued', leaving: entries.length > 0 && entries.every(entry => entry.leaving), rows: entries.map(({ item, leaving, fresh }) => ({ key: item.id, node: leaving
      ? <Leave key={item.id} height={ROW} onDone={() => gone(item.id)}><QueuedRow item={item} threadId={threadId} /></Leave>
      : <Rise key={item.id} kind="row" play={fresh}><QueuedRow item={item} threadId={threadId} /></Rise> })) },
  ]
  const sections = all.filter(section => section.rows.length > 0)
  const freshSections = useFreshIds(sections.map(section => ({ id: section.key })))
  const label = (section: Section, first: boolean) => {
    const node = <TrayLabel section={section.key} first={first} />
    // A section that appears rises in with its first row; one whose last row leaves closes up with it.
    return section.leaving ? <Leave key={`label-${section.key}`} height={labelHeight(first)} onDone={() => {}}>{node}</Leave>
      : <Rise key={`label-${section.key}`} kind="row" play={freshSections(section.key)}>{node}</Rise>
  }
  const budget = MAX_ROWS * ROW + labelHeight(true)
  // Measured without the rows already leaving: the body leaves its scrolling list as the leave starts, so the leave closes up
  // smoothly instead of the list snapping shorter once it ends.
  const leavingRows = entries.filter(entry => entry.leaving).length
  const content = sections.filter(section => !section.leaving).reduce((h, section, i) => h + labelHeight(i === 0) + (section.rows.length - (section.key === 'queued' ? leavingRows : 0)) * ROW, 0)
  if (content > budget) {
    // Past the budget: one virtual list of labels and rows (no nested scrollers), no enter/leave motion.
    const items = sections.flatMap((section, i) => [
      { key: `label-${section.key}`, node: label(section, i === 0), indent: 0, height: labelHeight(i === 0) },
      ...section.rows.map(row => ({ ...row, indent: section.key === 'subagents' ? INDENT : 0, height: ROW })),
    ])
    return (
      <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
        <TreeGroup {...SUBAGENT_TREE} open={open}>
          <virtual-list testId="composer-tray-list" style={{ width: '100%', height: peekHeight(items, budget + ROW / 2) }}>
            {items.map(item => <div key={item.key} style={{ display: 'flex', flexDirection: 'column', paddingLeft: BODY_PAD + item.indent, paddingRight: BODY_PAD }}>{item.node}</div>)}
          </virtual-list>
        </TreeGroup>
      </div>
    )
  }
  return (
    <div testId="composer-tray-body" style={{ display: 'flex', flexDirection: 'column', paddingLeft: BODY_PAD, paddingRight: BODY_PAD, paddingBottom: 6 }}>
      {sections.map((section, i) => (
        <div key={section.key} testId={`composer-tray-section-${section.key}`} style={{ display: 'flex', flexDirection: 'column' }}>
          {label(section, i === 0)}
          {section.key === 'subagents'
            ? <div style={{ display: 'flex', flexDirection: 'column', marginLeft: INDENT }}><TreeGroup {...SUBAGENT_TREE} open={open}>{section.rows.map(row => row.node)}</TreeGroup></div>
            : section.rows.map(row => row.node)}
        </div>
      ))}
    </div>
  )
}

/** The list's height: it ends halfway down the row nearest `target`, so the half row under the edge says the list goes on. */
export function peekHeight(items: readonly { key: string; height: number }[], target: number) {
  let top = 0, best = target, distance = Infinity
  for (const item of items) {
    const middle = top + item.height / 2
    if (!item.key.startsWith('label-') && Math.abs(middle - target) < distance) { distance = Math.abs(middle - target); best = middle }
    top += item.height
  }
  return best
}

/** A section's label; the subagents' stem starts under it, in the icon column, and runs on into the first row. */
function TrayLabel({ section, first }: { section: SectionKey; first: boolean }) {
  const shape = useMemo<TreeShape | null>(() => {
    if (section !== 'subagents') return null
    const top = first ? SECTION_LABEL.firstTop : SECTION_LABEL.top
    return { anchor: top + SECTION_LABEL.line / 2, below: { x: STEM - BODY_PAD, from: top + SECTION_LABEL.line } }
  }, [section, first])
  return (
    <div testId={`composer-tray-label-${section}`} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <SectionLabel first={first} inset={ROW_PAD}>{SECTION_NAME[section]}</SectionLabel>
      {shape && <TreeLines shape={shape} />}
    </div>
  )
}

/** Ids present at the first render are not fresh: only rows that arrive later rise in (initial loads do not animate). */
const FRESH_MS = 400
function useFreshIds(items: readonly { id: string }[]) {
  const seen = useRef<Map<string, number> | null>(null)
  seen.current ??= new Map(items.map(item => [item.id, -Infinity]))
  const now = performance.now()
  for (const item of items) if (!seen.current.has(item.id)) seen.current.set(item.id, now)
  // Only while it is arriving: a row remounted later (the body switching to or from its scrolling list) paints at rest.
  return (id: string) => now - (seen.current!.get(id) ?? now) < FRESH_MS
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
  const focus = useRowFocus()
  return <IconButton testId={testId} label={label} icon={glyph} glyph={size} size="sm" onClick={onClick} {...focus} />
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
  const tree = useTreeSlot()
  return (
    // The root carries the row's tree slice (stem, tick or elbow), drawn after the row and outside its dimming.
    <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    {/* Finished and stopped rows settle to the quieter ink (150 ms fade, paint-only); working and failed rows stay at full. */}
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
    {tree.lines}
    </div>
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
      glyph={thread.status === 'running' ? <MatrixLoader whole /> : approval ? <Icon source={G.hand} size={14} color={amber} /> : thread.status === 'failed' ? <Icon source={T.alert} size={14} color={t.red} /> : <Icon source={T.check} size={14} color={ink(t, 0.45)} />}>
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
  // A running turn of an agent that takes steering can get the follow-up now instead of after it ends.
  const steerable = useApp((s) => { const thread = s.threads.find((x) => x.id === threadId); return !!thread && thread.status === 'running' && STEERABLE.includes(thread.provider.kind) })
  const steer = () => void steerQueued(threadId, item).catch(e => reportError('Couldn’t steer with this follow-up. If the turn just ended it was already sent; otherwise try again', e))
  return (
    <Row testId={`queued-${item.id}`} hoverable={false}
      glyph={thumb && preview.imagesOnly
        ? <img src={thumb} objectFit="cover" style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: outline }} />
        : <Icon source={preview.kind === 'update' ? G.workflow : G.clock} size={14} color={ink(t, 0.5)} />}
      trailing={<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {preview.imageCount > 0 && !preview.imagesOnly && <ImageCount count={preview.imageCount} thumb={thumb} />}
        {steerable && <Button testId={`queued-steer-${item.id}`} variant="ghost" size="sm" onClick={steer}>Steer now</Button>}
        <IconButton testId={`queued-remove-${item.id}`} label="Remove queued follow-up" icon={G.x} glyph={12} size="sm" onClick={remove} />
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
