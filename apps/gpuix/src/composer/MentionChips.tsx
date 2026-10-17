// Filter chips across the top of the @ picker (`ComposerMentionChips`): All, Threads,
// Notes, Tasks, Files, Plugins. One sliding pill marks the selection (`.t-tabs-pill`:
// transform/width over `--duration-fast` smooth-out, none under Reduce Motion; the
// first measurement lands in place). The chips never take focus: the editor keeps
// the caret, and ←/→ switch chips until a term is typed (`Completion.tsx`).
import { motion, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { observeElementBounds } from '../native/layout.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { OPTION_RADIUS } from './Menu.tsx'

export function MentionChips<T extends string>({ chips, active, onSelect }: { chips: readonly { id: T; label: string }[]; active: T; onSelect: (id: T) => void }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const [row, setRow] = useState<PublicInstance | null>(null)
  const nodes = useRef(new Map<string, PublicInstance | null>())
  const [activeNode, setActiveNode] = useState<PublicInstance | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [pill, setPill] = useState<{ x: number; width: number } | null>(null)
  const rects = useRef<{ row?: { x: number }; chip?: { x: number; width: number } }>({})
  useEffect(() => setActiveNode(nodes.current.get(active) ?? null), [active, row, chips.length])
  useEffect(() => {
    if (!row || !activeNode) return
    const place = () => {
      const { row: r, chip } = rects.current
      if (r && chip) setPill(previous => previous && previous.x === chip.x - r.x && previous.width === chip.width ? previous : { x: chip.x - r.x, width: chip.width })
    }
    const stops = [
      observeElementBounds(renderer, row.id, event => { if (event.rect) { rects.current.row = event.rect; place() } }),
      observeElementBounds(renderer, activeNode.id, event => { if (event.rect) { rects.current.chip = event.rect; place() } }),
    ]
    return () => stops.forEach(stop => stop())
  }, [renderer, row, activeNode])
  return <div ref={setRow} testId="completion-chips" role="tablist" style={{ position: 'relative', display: 'flex', flexShrink: 0, gap: 2, marginLeft: 6, marginRight: 6, marginTop: 6, minWidth: 0 }}>
    {pill && <motion.div
      testId="completion-chip-pill"
      initial={{ left: pill.x, width: pill.width }}
      animate={{ left: pill.x, width: pill.width }}
      transition={REDUCED_MOTION ? { duration: 0 } : { duration: DURATION.fast, ease: [...EASE.smoothOut] }}
      style={{ position: 'absolute', top: 0, height: 24, borderRadius: OPTION_RADIUS, backgroundColor: t.buttonSecondary, pointerEvents: 'none' }}
    />}
    {chips.map(chip => {
      const selected = chip.id === active
      return <div
        key={chip.id}
        ref={node => { nodes.current.set(chip.id, node) }}
        testId={`completion-category-${chip.id}`}
        role="tab"
        aria-selected={selected}
        onClick={() => onSelect(chip.id)}
        onMouseEnter={() => setHover(chip.id)}
        onMouseLeave={() => setHover(h => (h === chip.id ? null : h))}
        style={{ display: 'flex', alignItems: 'center', flexShrink: 0, height: 24, paddingLeft: 10, paddingRight: 10, borderRadius: OPTION_RADIUS, cursor: 'pointer' }}
      >
        <Label size={13} lineHeight={20} color={selected || hover === chip.id ? t.text : t.textSecondary}>{chip.label}</Label>
      </div>
    })}
  </div>
}
