// The foot of a task's page (`views/tasks/TaskRunDock.tsx`, `.tk-dock` in `tasks.css`): one slot, 660px at most, floating over the
// page. Collapsed it is a one-line field; pressing it (or ⌘↵) opens the run composer in the same slot, growing upward from the
// field (`Collapse`: height and opacity over 220 ms, a fade under Reduce Motion). Esc, the Hide chevron, or a click on the page
// while the draft is empty puts it back. A band above it fades into the opaque page colour, so rows never show through.
import { PROVIDER_LABEL } from '@/lib/format'
import { isLiveRun, latestRun } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { Collapse } from '../motion/kit.tsx'
import { Presence } from '../motion/Presence.tsx'
import { DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { over } from '../theme.ts'
import { notesTokens } from '../notes/kit.tsx'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { raisedFill, raisedRim, useGlass } from '../platform/glass.ts'
import { DockShell, DOCK_FIELD_HEIGHT, DOCK_GUTTER } from './DockShell.tsx'
import { RunComposer } from './RunComposer.tsx'
import { markDockEscape, setTasks, useTasks } from './store.ts'

const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] } }

export function TaskDock({ task, right, onHeight, emptyRef }: { task: TaskItem; right: number; onHeight: (height: number) => void; emptyRef: { current: boolean } }) {
  const t = useTheme()
  const g = useGlass()
  const k = notesTokens(t)
  const open = useTasks((s) => s.composer?.length === 1 && s.composer[0] === task.id)
  const run = latestRun(task)
  const following = !!run && (isLiveRun(run) || task.status === 'needs_review')
  const dark = t.variant === 'dark'
  const close = () => setTasks({ composer: null })
  const field = (
    <div
      testId="task-send-open"
      tabIndex={0}
      role="button"
      aria-label={following ? 'Follow up with the agent' : `Tell an agent what to do with ${task.key}`}
      onClick={() => setTasks({ composer: [task.id] })}
      onKeyDown={(e) => { if (e.key === 'enter') setTasks({ composer: [task.id] }) }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        height: DOCK_FIELD_HEIGHT,
        paddingLeft: 16,
        paddingRight: 16,
        borderRadius: 14,
        cursor: 'text',
        // Opaque in both themes: the dark field is the page with a 5% lift, the light one the page with a hairline and a soft shadow.
        // On whole-window glass it is a raised card (tint, rim, top highlight, no shadow): the list ends above it, so nothing passes under.
        position: 'relative',
        backgroundColor: raisedFill(g, dark ? over(ink(t, 0.05), t.surface) : t.surface),
        borderWidth: g.on ? 1 : 0.5,
        borderColor: raisedRim(g, dark ? k.hair : ink(t, 0.12)),
        ...(dark || g.on ? {} : { boxShadow: { offsetX: 0, offsetY: 2, blurRadius: 8, spreadRadius: -2, color: 'rgba(0, 0, 0, 0.06)' } }),
        hover: { backgroundColor: raisedFill(g, dark ? over(ink(t, 0.07), t.surface) : t.surface, true), borderColor: g.on ? g.rim : dark ? ink(t, 0.12) : ink(t, 0.16) },
      }}
    >
      <GlassEdge radius={14} color={g.highlight} />
      <ProviderMark kind={(following ? run!.provider.kind : 'claude-code')} size={14} />
      <Label color={k.fg3} size={13} lineHeight={19.5} truncate style={{ flexGrow: 1 }}>
        {following ? `Follow up with ${PROVIDER_LABEL[run!.provider.kind]}…` : `Tell an agent what to do with ${task.key}…`}
      </Label>
      <Label color={k.fg4} size={12}>⌘↵</Label>
    </div>
  )
  return (
    <DockShell right={right} onHeight={onHeight} onEscape={() => { if (open) { markDockEscape(); close() } }}>
      {/* The field waits under the composer: it fades out as the composer grows over it, and back in as it shrinks. */}
      <Presence show={!open} enter={PATCHED_NATIVE ? fade : undefined} exit={{ to: { opacity: 0 }, duration: 0.1 }} style={{ position: 'absolute', left: DOCK_GUTTER, right: DOCK_GUTTER, bottom: 0 }}>
        {field}
      </Presence>
      {REDUCED_MOTION ? (
        <Presence show={open} enter={PATCHED_NATIVE ? fade : undefined} exit={{ to: { opacity: 0 }, duration: 0.1 }} style={{ position: 'relative' }}>
          {open ? <RunComposer key={task.id} ids={[task.id]} onEmptyChange={(empty) => { emptyRef.current = empty }} /> : null}
        </Presence>
      ) : (
        <Collapse open={open}>
          <RunComposer key={task.id} ids={[task.id]} onEmptyChange={(empty) => { emptyRef.current = empty }} />
        </Collapse>
      )}
    </DockShell>
  )
}
