// The new chat's pick-up (ADE-62 spec §3): Continue (the project's 3 latest threads, click to open) and Up next (its top 3
// open tasks, click to attach one to the message), two quiet lists of 32 pt rows hanging 32 below the composer, out of the
// layout flow, so their data arriving, changing or being absent never moves the composer.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskItem, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { RADIUS, useControls } from '../kit/controls.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Tip } from '../nav/overlay.tsx'
import { PriorityGlyph } from '../tasks/Glyphs.tsx'
import { PRIORITY_LABEL } from '@/state/tasksModel'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { continueMeta, movePickup } from './model.ts'

/** Rows in either group, and where a keyboard walk starts. */
export interface PickUpHandle { focusFirst: () => boolean }

/** Long titles get the full text in a tooltip (a title over this many characters may truncate in a 348 pt column). */
const TIP_FROM = 38

export function PickUp({ threads, tasks, tasksReady, attachedId, rows, narrow, onOpen, onToggleTask, onLeave, handleRef, frozen = false }: {
  threads: Thread[]
  tasks: TaskItem[]
  /** The tasks have loaded; until then Up next is empty and fades in when they arrive. */
  tasksReady: boolean
  attachedId: string | null
  /** Rows per group that fit above the pane's bottom (0 hides the pick-up). */
  rows: number
  /** The column is under 600: the groups stack. */
  narrow: boolean
  onOpen: (thread: Thread) => void
  onToggleTask: (task: TaskItem) => void
  /** ↑ from a first row, or Esc: back to the composer. */
  onLeave: () => void
  handleRef?: (handle: PickUpHandle) => void
  /** A frozen copy (the send transition's exit layer). */
  frozen?: boolean
}) {
  const renderer = useGpuixRequired()
  // While the pointer or focus is inside, rows keep their order (a reorder waits for leave); meta still updates in place.
  const [inside, setInside] = useState(false)
  const [focusInside, setFocusInside] = useState(false)
  const held = inside || focusInside
  const continueRows = useHeldOrder(threads, held).slice(0, rows)
  const nextRows = useHeldOrder(tasks, held).slice(0, rows)
  // Up next arrives late when the tasks were not loaded yet: it fades in (opacity only, nothing else moves).
  const [lateTasks] = useState(!tasksReady)
  const nodes = useRef<(PublicInstance | null)[][]>([[], []])
  const groups = [continueRows.length ? 'continue' : null, nextRows.length ? 'next' : null].filter(Boolean) as ('continue' | 'next')[]
  const counts = groups.map((g) => (g === 'continue' ? continueRows.length : nextRows.length))
  const focusAt = (group: number, row: number) => {
    const node = nodes.current[group]?.[row]
    if (node) renderer.focusElement?.(node.id)
  }
  useEffect(() => {
    handleRef?.({ focusFirst: () => { if (!groups.length || rows <= 0) return false; focusAt(0, 0); return true } })
  })
  if (rows <= 0 || !groups.length) return null
  const keyDown = (group: number, row: number, activate: () => void) => (e: { key?: string; modifiers?: { cmd?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean } }) => {
    const m = e.modifiers
    if (m?.cmd || m?.alt || m?.ctrl) return
    if (e.key === 'enter' || e.key === 'space') { activate(); return }
    if (e.key === 'escape') { onLeave(); return }
    if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
      const next = movePickup({ group: group as 0 | 1, row }, e.key, [counts[0] ?? 0, counts[1] ?? 0])
      if (!next) onLeave()
      else focusAt(next.group, next.row)
    }
  }
  const column = (key: 'continue' | 'next', group: number): ReactNode => key === 'continue' ? (
    <Group key="continue" title="Continue">
      {continueRows.map((thread, row) => (
        <ContinueRow
          key={thread.id}
          thread={thread}
          nodeRef={(node) => { nodes.current[group]![row] = node }}
          onClick={() => onOpen(thread)}
          onKeyDown={keyDown(group, row, () => onOpen(thread))}
          frozen={frozen}
        />
      ))}
    </Group>
  ) : (
    <div key="next" paintTransform={lateTasks && PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] } } : undefined} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0 }}>
      <Group title="Up next">
        {nextRows.map((task, row) => (
          <UpNextRow
            key={task.id}
            task={task}
            attached={task.id === attachedId}
            nodeRef={(node) => { nodes.current[group]![row] = node }}
            onClick={() => onToggleTask(task)}
            onKeyDown={keyDown(group, row, () => onToggleTask(task))}
            frozen={frozen}
          />
        ))}
      </Group>
    </div>
  )
  return (
    <div
      testId="draft-pickup"
      onMouseEnter={() => setInside(true)}
      onMouseLeave={() => setInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={() => setFocusInside(false)}
      style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: narrow ? 16 : 24, width: '100%', ...(frozen ? { pointerEvents: 'none' as const } : {}) }}
    >
      {groups.map((key, group) => column(key, group))}
      {/* One group keeps its column: the second stays empty. */}
      {groups.length === 1 && !narrow && <div style={{ flexGrow: 1, flexBasis: 0 }} />}
    </div>
  )
}

/** The list as it was while `held`, with fresh objects for rows still in it; the new order applies once released. */
function useHeldOrder<T extends { id: string }>(list: T[], held: boolean): T[] {
  const order = useRef<string[]>(list.map((x) => x.id))
  if (!held) order.current = list.map((x) => x.id)
  if (!held) return list
  const byId = new Map(list.map((x) => [x.id, x]))
  const kept = order.current.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  return kept.concat(list.filter((x) => !order.current.includes(x.id)))
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexBasis: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 20, paddingLeft: 8 }}>
        <Label color={t.textTertiary} size={12} lineHeight={16} weight={500}>{title}</Label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}

/** A 32 pt row: fill on hover (ink 0.06) and press (0.09), never a scale; a 2 pt focus ring outside it. */
function Row({ label, nodeRef, onClick, onKeyDown, fill, title, children, frozen }: {
  label: string
  nodeRef: (node: PublicInstance | null) => void
  onClick: () => void
  onKeyDown: (e: { key?: string }) => void
  fill?: string
  title: string
  children: (hover: boolean) => ReactNode
  frozen: boolean
}) {
  const c = useControls()
  const [hover, setHover] = useState(false)
  const row = (
    <div
      ref={nodeRef}
      role="button"
      tabIndex={frozen ? -1 : 0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 32, paddingLeft: 8, paddingRight: 8, borderRadius: RADIUS.sm, minWidth: 0, cursor: 'pointer',
        backgroundColor: fill ?? 'rgba(0, 0, 0, 0)',
        hover: { backgroundColor: fill ?? c.ghost.hover },
        active: { backgroundColor: c.ghost.press },
        focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 },
      }}
    >
      {children(hover && !frozen)}
    </div>
  )
  return [...title].length > TIP_FROM && !frozen ? <Tip label={title} size={348}>{row}</Tip> : row
}

function ContinueRow({ thread, nodeRef, onClick, onKeyDown, frozen }: { thread: Thread; nodeRef: (node: PublicInstance | null) => void; onClick: () => void; onKeyDown: (e: { key?: string }) => void; frozen: boolean }) {
  const t = useTheme()
  const meta = continueMeta(thread)
  const title = thread.title || 'New thread'
  return (
    <Row label={`Open thread ${title}, ${meta.text}`} title={title} nodeRef={nodeRef} onClick={onClick} onKeyDown={onKeyDown} frozen={frozen}>
      {(hover) => (
        <>
          <ProviderMark kind={thread.provider.kind} size={14} />
          <Label color={t.text} size={13} lineHeight={18} truncate style={{ flexGrow: 1 }}>{title}</Label>
          <Label color={hover ? t.textSecondary : meta.tone === 'working' ? t.taskRun : meta.tone === 'waiting' ? t.taskUrgent : t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' } as never}>
            {hover ? 'Open ›' : meta.text}
          </Label>
        </>
      )}
    </Row>
  )
}

function UpNextRow({ task, attached, nodeRef, onClick, onKeyDown, frozen }: { task: TaskItem; attached: boolean; nodeRef: (node: PublicInstance | null) => void; onClick: () => void; onKeyDown: (e: { key?: string }) => void; frozen: boolean }) {
  const t = useTheme()
  const c = useControls()
  const title = task.title || 'Untitled task'
  return (
    <Row
      label={attached ? `Remove ${task.key} from message` : `Add ${task.key} ${title} to message, ${PRIORITY_LABEL[task.priority]}`}
      title={title}
      nodeRef={nodeRef}
      onClick={onClick}
      onKeyDown={onKeyDown}
      fill={attached ? c.acc(t.variant === 'dark' ? 0.12 : 0.07) : undefined}
      frozen={frozen}
    >
      {(hover) => (
        <>
          <PriorityGlyph priority={task.priority} />
          <Label color={t.textTertiary} size={12} lineHeight={16} style={{ minWidth: 46, flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as never}>{task.key}</Label>
          <Label color={t.text} size={13} lineHeight={18} truncate style={{ flexGrow: 1 }}>{title}</Label>
          {(attached || hover) && (
            <Label color={attached ? c.accentFg : t.textSecondary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>
              {attached ? '✓ Added' : '+ Add to message'}
            </Label>
          )}
        </>
      )}
    </Row>
  )
}
