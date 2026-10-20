import { useState } from 'react'
import { useNav } from '../nav/store.ts'
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { Icon, glyph } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { over } from '../theme.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { TaskMenus } from './TaskMenus.tsx'
import { deleteTasks, setTasks } from './store.ts'
import { pressTransform } from '../motion/press.ts'
import { Presence } from '../motion/Presence.tsx'
import { BLUR, DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'

const TRASH = glyph(Delete02Icon)

export function SelectionBar({ ids, show, hints }: { ids: string[]; show: boolean; hints: boolean }) {
  const t = useTheme()
  const keyboard = useNav((s) => s.keyboardNav)
  const [last, setLast] = useState(ids)
  if (show && ids.join(',') !== last.join(',')) setLast(ids)
  // `.tk-selbar` (tasks.css:1695): in from 8 px low with a 2 px blur over 200 ms, out 4 px low over 140 ms; the keyboard shows and hides it at once.
  const ease = [...EASE.smoothOut] as [number, number, number, number]
  const enter = keyboard || !PATCHED_NATIVE ? undefined : REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease } }
    : { initial: { opacity: 0, translateY: 8, blur: BLUR.small }, animate: { opacity: 1, translateY: 0, blur: 0 }, transition: { duration: 0.2, ease } }
  // Press (`tasks.css`): `.primary` scales to 0.97 over 80 ms both ways; the `.tk-btn`s (Status, Priority, Delete, Clear) snap to
  // 0.97, since `.tk-btn` transitions only colours.
  // `.tk-selbar`: one raised 44px pill, centred over the page's foot (48px up, clearing the hint line).
  const dark = t.variant === 'dark'
  const float = dark ? over('rgba(255, 255, 255, 0.07)', t.surface) : t.popover
  const row = { display: 'flex', alignItems: 'center', height: 32, borderRadius: 8 } as const
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom: hints ? 48 : 16, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
    <Presence show={show} enter={enter} exit={{ to: { opacity: 0, translateY: 4 }, duration: keyboard ? 0 : 0.14 }} style={{ pointerEvents: 'auto' }}>
      <div testId="task-selection" style={{ display: 'flex', alignItems: 'center', gap: 2, height: 44, padding: 6, borderRadius: 14, backgroundColor: float, boxShadow: dark ? { offsetX: 0, offsetY: 14, blurRadius: 36, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.65)' } : { offsetX: 0, offsetY: 10, blurRadius: 28, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.18)' } }}>
        <div style={{ paddingLeft: 10, paddingRight: 12 }}><Label color={t.text} size={13} lineHeight={19.5} weight={500}>{`${last.length} selected`}</Label></div>
        <div testId="task-batch-open" tabIndex={0} aria-label="Send to agent" onClick={() => setTasks({ composer: last })} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') setTasks({ composer: last }) }} paintTransform={pressTransform(true, 0.97, 0.08, 0.08)} style={{ ...row, paddingLeft: 14, paddingRight: 14, marginRight: 6, backgroundColor: t.text, cursor: 'pointer', hover: { opacity: 0.9 } }}><Label color={t.surface} size={13} lineHeight={19.5} weight={500}>Send to agent</Label></div>
        <TaskMenus ids={last} property="status" label="Status" bar />
        <TaskMenus ids={last} property="priority" label="Priority" bar />
        <div testId="task-selection-delete" tabIndex={0} aria-label="Delete" onClick={() => void deleteTasks(last)} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') void deleteTasks(last) }} paintTransform={pressTransform(true, 0.97, 0, 0)} style={{ ...row, gap: 7, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><Icon source={TRASH} size={15} color={ink(t, 0.6)} /><Label color={ink(t, 0.86)} size={13} lineHeight={19.5}>Delete</Label></div>
        <div testId="task-selection-clear" tabIndex={0} aria-label="Clear selection" onClick={() => setTasks({ selected: new Set() })} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') setTasks({ selected: new Set() }) }} paintTransform={pressTransform(true, 0.97, 0, 0)} style={{ ...row, justifyContent: 'center', width: 32, marginLeft: 4, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><Icon source={N.x} size={15} color={ink(t, 0.4)} /></div>
      </div>
    </Presence>
  </div>
}
