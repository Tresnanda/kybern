// A `TextField` with a leading 14 px search glyph and, once there is a value, a trailing 16 px clear circle. `bare` is the
// palette's borderless input. Replaces the palette, Settings sidebar, PR list and Notes header searches.
import { Icon } from '../icons.tsx'
import { ICONS } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { useTheme } from '../ui.tsx'
import { useControls } from './controls.ts'
import { TextField, type TextFieldProps } from './Field.tsx'

export function SearchField({ value, onChange, onClear, trailing, ...props }: Omit<TextFieldProps, 'leading'> & { onClear?: () => void }) {
  const t = useTheme()
  const c = useControls()
  const clear = value && !props.disabled ? (
    <div role="button" aria-label="Clear search" onClick={() => { onChange(''); onClear?.() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 8, flexShrink: 0, backgroundColor: c.ink(0.12), cursor: 'pointer', hover: { backgroundColor: c.ink(0.2) } }}>
      <Icon source={N.x} size={9} color={t.variant === 'dark' ? '#181818' : '#ffffff'} style={{ pointerEvents: 'none' }} />
    </div>
  ) : null
  return <TextField {...props} value={value} onChange={onChange} leading={<Icon source={ICONS.search} size={14} color={t.textTertiary} style={{ pointerEvents: 'none' }} />} trailing={<>{trailing}{clear}</>} />
}
