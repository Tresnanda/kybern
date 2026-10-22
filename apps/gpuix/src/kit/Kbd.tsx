// `Kbd`: one chip per key, 18 high and at least 18 wide, 4 px padding, 11/500 secondary text on a transparent chip with a 1 px
// ink edge (Direction C), 3 px between keys. Right-aligned in palette and menu rows. Replaces `nav/overlay.tsx` Kbd.
import { Label } from '../ui.tsx'
import { RADIUS, useControls } from './controls.ts'

export function Kbd({ keys, testId }: { keys: readonly string[]; testId?: string }) {
  const c = useControls()
  return (
    <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      {keys.map((key, i) => (
        <div key={`${key}${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 18, minWidth: 18, paddingLeft: 4, paddingRight: 4, borderRadius: RADIUS.kbd, boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: c.kbd.edge, inset: true } }}>
          <Label color={c.kbd.fg} size={11} lineHeight={14} weight={500} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{key}</Label>
        </div>
      ))}
    </div>
  )
}
