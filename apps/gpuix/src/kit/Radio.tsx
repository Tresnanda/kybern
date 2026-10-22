// The one radio: 16 px, ring style. Off is a 1.5 px ink ring; on is an accent disc with a 7 px dot in the surface colour. The
// hit area is the row (`RadioRow`), so this is the glyph only. Replaces the hand-built radios of the question card and the PR
// review popover.
import { useControls } from './controls.ts'

export function Radio({ checked, disabled = false, invalid = false, testId }: { checked: boolean; disabled?: boolean; invalid?: boolean; testId?: string }) {
  const c = useControls()
  return (
    <div testId={testId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, borderRadius: 8, opacity: disabled ? 0.4 : 1, pointerEvents: 'none', ...(checked ? { backgroundColor: c.check.on } : { borderWidth: 1.5, borderColor: invalid ? c.field.invalid : c.check.edge }) }}>
      {checked && <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: c.radio.dot }} />}
    </div>
  )
}
