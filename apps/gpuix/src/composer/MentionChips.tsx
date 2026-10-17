// Filter chips across the top of the @ picker (`ComposerMentionChips`): All, Threads,
// Notes, Tasks, Files, Plugins. One sliding pill marks the selection (`SlidingPill.tsx`).
// The chips never take focus: the editor keeps the caret, and ←/→ switch chips until a
// term is typed (`Completion.tsx`).
import { useState } from 'react'
import { Label, useTheme } from '../ui.tsx'
import { OPTION_RADIUS } from './Menu.tsx'
import { Pill, useSlidingPill } from './SlidingPill.tsx'

export function MentionChips<T extends string>({ chips, active, onSelect }: { chips: readonly { id: T; label: string }[]; active: T; onSelect: (id: T) => void }) {
  const t = useTheme()
  const [hover, setHover] = useState<string | null>(null)
  const { rowRef, tab, pill } = useSlidingPill(active, chips.length)
  return <div ref={rowRef} testId="completion-chips" role="tablist" style={{ position: 'relative', display: 'flex', flexShrink: 0, gap: 2, marginLeft: 6, marginRight: 6, marginTop: 6, minWidth: 0 }}>
    <Pill pill={pill} height={24} style={{ borderRadius: OPTION_RADIUS, backgroundColor: t.buttonSecondary }} />
    {chips.map(chip => {
      const selected = chip.id === active
      return <div
        key={chip.id}
        ref={tab(chip.id)}
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
