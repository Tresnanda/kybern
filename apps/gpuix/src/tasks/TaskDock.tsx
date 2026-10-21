// The foot of a task's page (`views/tasks/TaskRunDock.tsx`, `.tk-dock` in `tasks.css`): one slot, 660px at most, floating over the
// page. Collapsed it is a one-line field; pressing it (or ⌘↵) opens the run composer in the same slot, growing upward from the
// field (`Collapse`: height and opacity over 220 ms, a fade under Reduce Motion). Esc, the Hide chevron, or a click on the page
// while the draft is empty puts it back. A band above it fades into the opaque page colour, so rows never show through.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { PROVIDER_LABEL } from '@/lib/format'
import { isLiveRun, latestRun } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { Collapse } from '../motion/kit.tsx'
import { Presence } from '../motion/Presence.tsx'
import { DURATION, EASE } from '../motion/tokens.ts'
import { observeElementBounds } from '../native/layout.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { alpha } from '../transcript/kit.tsx'
import { over } from '../theme.ts'
import { notesTokens } from '../notes/kit.tsx'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { RunComposer } from './RunComposer.tsx'
import { markDockEscape, setTasks, useTasks } from './store.ts'

/** `.tk-dock[data-filled]`: the gradient band above the dock. */
const BAND = 28
const FIELD_HEIGHT = 44
const GUTTER = 16

const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] } }

export function TaskDock({ task, right, onHeight, emptyRef }: { task: TaskItem; right: number; onHeight: (height: number) => void; emptyRef: { current: boolean } }) {
  const t = useTheme()
  const k = notesTokens(t)
  const renderer = useGpuixRequired()
  const open = useTasks((s) => s.composer?.length === 1 && s.composer[0] === task.id)
  const node = useRef<PublicInstance | null>(null)
  // The page's bottom padding follows the dock's height (`--tk-dock-h`).
  useEffect(() => {
    const id = node.current?.id
    if (id == null) return
    return observeElementBounds(renderer, id, (event) => { if (event.rect) onHeight(Math.round(event.rect.height)) })
  }, [renderer])
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
        height: FIELD_HEIGHT,
        paddingLeft: 16,
        paddingRight: 16,
        borderRadius: 14,
        cursor: 'text',
        // Opaque in both themes: the dark field is the page with a 5% lift, the light one the page with a hairline and a soft shadow.
        backgroundColor: dark ? over(ink(t, 0.05), t.surface) : t.surface,
        borderWidth: 0.5,
        borderColor: dark ? k.hair : ink(t, 0.12),
        ...(dark ? {} : { boxShadow: { offsetX: 0, offsetY: 2, blurRadius: 8, spreadRadius: -2, color: 'rgba(0, 0, 0, 0.06)' } }),
        hover: { backgroundColor: dark ? over(ink(t, 0.07), t.surface) : t.surface, borderColor: dark ? ink(t, 0.12) : ink(t, 0.16) },
      }}
    >
      <ProviderMark kind={(following ? run!.provider.kind : 'claude-code')} size={14} />
      <Label color={k.fg3} size={13} lineHeight={19.5} truncate style={{ flexGrow: 1 }}>
        {following ? `Follow up with ${PROVIDER_LABEL[run!.provider.kind]}…` : `Tell an agent what to do with ${task.key}…`}
      </Label>
      <Label color={k.fg4} size={12}>⌘↵</Label>
    </div>
  )
  return (
    <div
      ref={(el) => { node.current = el }}
      testId="task-dock"
      style={{ position: 'absolute', left: 0, right, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: BAND, paddingBottom: GUTTER }}
    >
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: BAND, pointerEvents: 'none', background: { type: 'linear-gradient', angle: 180, stops: [{ color: alpha(t.surface, 0), position: 0 }, { color: t.surface, position: 1 }] } }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: BAND, bottom: 0, pointerEvents: 'none', backgroundColor: t.surface }} />
      <div
        onKeyDown={(e) => { if (open && e.key === 'escape' && !e.defaultPrevented) { markDockEscape(); close() } }}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', width: '100%', maxWidth: 660 + GUTTER * 2, minHeight: FIELD_HEIGHT, paddingLeft: GUTTER, paddingRight: GUTTER }}
      >
        {/* The field waits under the composer: it fades out as the composer grows over it, and back in as it shrinks. */}
        <Presence show={!open} enter={PATCHED_NATIVE ? fade : undefined} exit={{ to: { opacity: 0 }, duration: 0.1 }} style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: 0 }}>
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
      </div>
    </div>
  )
}
