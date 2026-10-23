// The held row or card, drawn as the desktop's drag overlay: `.tk-row` with `--task-card-hover` and the
// hover shadow at radius 8 in the list, `.tk-card[data-overlay]` with the lifted shadow on the board.
// It is the item's own content (glyphs, key, title, project, age), not a label.
import { relativeTime } from '@/lib/format'
import { isOpenStatus } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { ProjectDot } from '../notes/kit.tsx'
import { over } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { useGlass } from '../platform/glass.ts'
import { PriorityGlyph, StatusGlyph } from './Glyphs.tsx'

// Board rotation remains pending the native carry-resource acceptance gate.
/** `--task-card-hover` and `--task-shadow-card-hover` (tasks.css:58, 60 dark; 28 light).
 * GPUI uses Gaussian sigma directly; CSS box-shadow blur has sigma = radius/2. */
export function useHeldChrome() {
  const t = useTheme()
  const g = useGlass()
  const dark = t.variant === 'dark'
  return {
    // A held card floats over the board: the dense glass float on whole-window glass, never an opaque slab.
    backgroundColor: g.on ? g.denseFloat : dark ? over(ink(t, 0.055), t.surface) : t.surface,
    borderWidth: dark ? 0 : 0.5,
    borderColor: 'rgba(0, 0, 0, 0.12)',
    boxShadow: dark
      ? { offsetX: 0, offsetY: 6, blurRadius: 18 / 2, spreadRadius: -6, color: 'rgba(0, 0, 0, 0.5)' }
      : { offsetX: 0, offsetY: 4, blurRadius: 14 / 2, spreadRadius: -4, color: 'rgba(0, 0, 0, 0.12)' },
  }
}

export function GhostRow({ task, project }: { task: TaskItem; project: string }) {
  const t = useTheme()
  const chrome = useHeldChrome()
  return (
    <div testId="task-ghost" style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', width: '100%', height: '100%', paddingLeft: 8, paddingRight: 20, borderRadius: 8, ...chrome }}>
      {/* The row's checkbox slot, so the held row's columns stay where they were. */}
      <div style={{ width: 22, flexShrink: 0 }} />
      <div style={{ width: 28, flexShrink: 0 }}><PriorityGlyph priority={task.priority} /></div>
      <Label color={t.textTertiary} size={12} truncate style={{ width: 58, flexShrink: 0, pointerEvents: 'none' }}>{task.key}</Label>
      <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', width: 26, flexShrink: 0 }}><StatusGlyph status={task.status} /></div>
      <Label color={isOpenStatus(task.status) ? t.text : t.textSecondary} size={13} truncate style={{ flexGrow: 1, minWidth: 0, pointerEvents: 'none' }}>{task.title || 'Untitled'}</Label>
      <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 8, width: 132, flexShrink: 0, paddingLeft: 12 }}>
        <ProjectDot projectId={task.scope === 'project' ? task.project_id ?? null : null} />
        <Label color={ink(t, 0.6)} size={12} lineHeight={18} truncate style={{ pointerEvents: 'none' }}>{project}</Label>
      </div>
      <div style={{ pointerEvents: 'none', display: 'flex', justifyContent: 'flex-end', width: 34, flexShrink: 0 }}>
        <Label color={t.textTertiary} size={12} lineHeight={18} style={{ pointerEvents: 'none' }}>{relativeTime(task.created_at, Date.now())}</Label>
      </div>
    </div>
  )
}

export function GhostCard({ task }: { task: TaskItem }) {
  const t = useTheme()
  const chrome = useHeldChrome()
  return (
    <div testId="task-ghost" style={{ pointerEvents: 'none', position: 'relative', width: '100%', height: '100%' }}>
    {/* tasks.css data-overlay adds this shadow to the hover shadow. */}
    <div style={{ pointerEvents: 'none', position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 10, boxShadow: { offsetX: 0, offsetY: 18, blurRadius: 40 / 2, spreadRadius: -12, color: 'rgba(0, 0, 0, 0.35)' } }} />
    <div style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'column', width: '100%', height: '100%', paddingTop: 11, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, borderRadius: 10, ...chrome }}>
      <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 7, height: 16, flexShrink: 0 }}>
        <ProjectDot projectId={task.scope === 'project' ? task.project_id ?? null : null} />
        <Label color={t.textTertiary} size={12} lineHeight={16} style={{ pointerEvents: 'none' }}>{task.key}</Label>
        <div style={{ flexGrow: 1 }} />
        {task.priority !== 0 && <PriorityGlyph priority={task.priority} />}
      </div>
      <div style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'column', marginTop: 6, width: '100%' }}>
        <Label color={isOpenStatus(task.status) ? t.text : t.textSecondary} size={13} lineHeight={18} style={{ width: '100%', pointerEvents: 'none' }}>{task.title || 'Untitled'}</Label>
      </div>
    </div>
    </div>
  )
}
