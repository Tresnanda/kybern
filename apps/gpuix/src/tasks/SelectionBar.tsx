import { useState } from 'react'
import { useNav } from '../nav/store.ts'
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { Icon, glyph } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { over } from '../theme.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { TaskMenus } from './TaskMenus.tsx'
import { deleteTasks, setTasks } from './store.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Presence } from '../motion/Presence.tsx'
import { BLUR, DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'

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
  const g = useGlass()
  const float = frostFill(g, 'pills', dark ? over('rgba(255, 255, 255, 0.07)', t.surface) : t.popover)
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom: hints ? 48 : 16, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
    <Presence show={show} enter={enter} exit={{ to: { opacity: 0, translateY: 4 }, duration: keyboard ? 0 : 0.14 }} style={{ pointerEvents: 'auto' }}>
      <div testId="task-selection" backdrop={frostBackdrop(g, 'pills', 14)} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, height: 44, padding: 6, borderRadius: 14, backgroundColor: float, ...(g.on ? { borderWidth: 1, borderColor: g.pillRim } : { boxShadow: dark ? { offsetX: 0, offsetY: 14, blurRadius: 36, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.65)' } : { offsetX: 0, offsetY: 10, blurRadius: 28, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.18)' } }) }}>
        <GlassEdge radius={14} color={g.frostHighlight} />
        <div style={{ paddingLeft: 10, paddingRight: 12 }}><Label color={t.text} size={13} lineHeight={19.5} weight={500}>{`${last.length} selected`}</Label></div>
        <Button testId="task-batch-open" variant="primary" size="lg" label="Send to agent" style={{ marginRight: 6 }} onClick={() => setTasks({ composer: last })}>Send to agent</Button>
        <TaskMenus ids={last} property="status" label="Status" bar />
        <TaskMenus ids={last} property="priority" label="Priority" bar />
        <Button testId="task-selection-delete" variant="ghost" danger size="lg" icon={TRASH} onClick={() => void deleteTasks(last)}>Delete</Button>
        <IconButton testId="task-selection-clear" size="lg" label="Clear selection" icon={N.x} glyph={15} style={{ marginLeft: 4 }} onClick={() => setTasks({ selected: new Set() })} />
      </div>
    </Presence>
  </div>
}
