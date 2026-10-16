// The held row or card, drawn as the desktop's drag overlay: `.tk-row` with `--task-card-hover` and the
// hover shadow at radius 8 in the list, `.tk-card[data-overlay]` with the lifted shadow on the board.
// It is the item's own content (glyphs, key, title, project, age), not a label.
import { relativeTime } from '@/lib/format'
import { isOpenStatus } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { ProjectDot } from '../notes/kit.tsx'
import { over } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { PriorityGlyph, StatusGlyph } from './Glyphs.tsx'

/** `--task-card-hover` and `--task-shadow-card-hover` (tasks.css:58, 60 dark; 28 light). */
export function useHeldChrome(extra = false) {
  const t = useTheme()
  const dark = t.variant === 'dark'
  return {
    backgroundColor: dark ? over(ink(t, 0.055), t.surface) : t.surface,
    borderWidth: dark ? 0 : 0.5,
    borderColor: 'rgba(0, 0, 0, 0.12)',
    boxShadow: dark
      ? { offsetX: 0, offsetY: extra ? 18 : 6, blurRadius: extra ? 40 : 18, spreadRadius: extra ? -12 : -6, color: extra ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.5)' }
      : { offsetX: 0, offsetY: extra ? 18 : 4, blurRadius: extra ? 40 : 14, spreadRadius: extra ? -12 : -4, color: extra ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.12)' },
  }
}

export function GhostRow({ task, project }: { task: TaskItem; project: string }) {
  const t = useTheme()
  const chrome = useHeldChrome()
  return (
    <div testId="task-ghost" style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', width: '100%', height: '100%', paddingLeft: 20, paddingRight: 20, borderRadius: 8, ...chrome }}>
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
  const chrome = useHeldChrome(true)
  return (
    <div testId="task-ghost" style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'column', width: '100%', height: '100%', paddingTop: 11, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, borderRadius: 10, ...chrome }}>
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
  )
}
