import { motion } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { useNav } from '../nav/store.ts'
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { Icon, glyph } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { over } from '../theme.ts'
import { EASE_OUT, ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { TaskMenus } from './TaskMenus.tsx'
import { deleteTasks, setTasks } from './store.ts'

const TRASH = glyph(Delete02Icon)

export function SelectionBar({ ids, show, hints }: { ids: string[]; show: boolean; hints: boolean }) {
  const t = useTheme()
  const keyboard = useNav((s) => s.keyboardNav)
  const instant = REDUCED_MOTION || keyboard
  const [mounted, setMounted] = useState(show)
  const [last, setLast] = useState(ids)
  if (show && !mounted) setMounted(true)
  if (show && ids.join(',') !== last.join(',')) setLast(ids)
  useEffect(() => {
    if (show) return
    const timer = setTimeout(() => setMounted(false), instant ? 0 : 150)
    return () => clearTimeout(timer)
  }, [show, instant])
  if (!mounted) return null
  // `.tk-selbar`: one raised 44px pill, centred over the page's foot (48px up, clearing the hint line).
  const dark = t.variant === 'dark'
  const float = dark ? over('rgba(255, 255, 255, 0.07)', t.surface) : t.popover
  const row = { display: 'flex', alignItems: 'center', height: 32, borderRadius: 8 } as const
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom: hints ? 48 : 16, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
    <motion.div initial={instant ? false : { opacity: 0, translateY: 8 }} animate={{ opacity: show ? 1 : 0, translateY: show || instant ? 0 : 4 }} transition={{ duration: instant ? 0 : 0.2, ease: EASE_OUT }} style={{ pointerEvents: show ? 'auto' : 'none' }}>
      <div testId="task-selection" style={{ display: 'flex', alignItems: 'center', gap: 2, height: 44, padding: 6, borderRadius: 14, backgroundColor: float, boxShadow: dark ? { offsetX: 0, offsetY: 14, blurRadius: 36, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.65)' } : { offsetX: 0, offsetY: 10, blurRadius: 28, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.18)' } }}>
        <div style={{ paddingLeft: 10, paddingRight: 12 }}><Label color={t.text} size={13} lineHeight={19.5} weight={500}>{`${last.length} selected`}</Label></div>
        <div testId="task-batch-open" tabIndex={0} aria-label="Send to agent" onClick={() => setTasks({ composer: last })} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') setTasks({ composer: last }) }} style={{ ...row, paddingLeft: 14, paddingRight: 14, marginRight: 6, backgroundColor: t.text, cursor: 'pointer', hover: { opacity: 0.9 } }}><Label color={t.surface} size={13} lineHeight={19.5} weight={500}>Send to agent</Label></div>
        <TaskMenus ids={last} property="status" label="Status" bar />
        <TaskMenus ids={last} property="priority" label="Priority" bar />
        <div testId="task-selection-delete" tabIndex={0} aria-label="Delete" onClick={() => void deleteTasks(last)} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') void deleteTasks(last) }} style={{ ...row, gap: 7, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><Icon source={TRASH} size={15} color={ink(t, 0.6)} /><Label color={ink(t, 0.86)} size={13} lineHeight={19.5}>Delete</Label></div>
        <div testId="task-selection-clear" tabIndex={0} aria-label="Clear selection" onClick={() => setTasks({ selected: new Set() })} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') setTasks({ selected: new Set() }) }} style={{ ...row, justifyContent: 'center', width: 32, marginLeft: 4, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><Icon source={N.x} size={15} color={ink(t, 0.4)} /></div>
      </div>
    </motion.div>
  </div>
}
