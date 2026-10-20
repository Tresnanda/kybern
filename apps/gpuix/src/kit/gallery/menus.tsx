// GPUIX twin of `visual/kit/sections/menus.tsx`. Also shows what was picked and whether the menu is open (below
// the compared area) so `scripts/kit9-menus-check.ts` can assert behaviour.
import { Copy01Icon } from '@hugeicons/core-free-icons'
import { useState, type ComponentType } from 'react'
import { glyph } from '../../icons.tsx'
import { N } from '../../nav/glyphs.ts'
import { Menu, MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator, MenuSub } from '../../nav/overlay.tsx'
import { Label, useTheme } from '../../ui.tsx'

function MenuDemo() {
  const t = useTheme()
  const [open, setOpen] = useState(true)
  const [picked, setPicked] = useState('none')
  const [theme, setTheme] = useState('dark')
  const [hints, setHints] = useState(true)
  const [color, setColor] = useState('green')
  const pick = (name: string, fn?: () => void) => () => { setPicked(name); fn?.() }
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 1280, height: 820 }}>
      <div style={{ position: 'absolute', left: 40, top: 40, display: 'flex' }}>
        <Menu
          open={open}
          onOpenChange={setOpen}
          side="bottom"
          align="start"
          sideOffset={4}
          minWidth={208}
          testId="menu"
          trigger={() => (
            <div testId="menu-trigger" style={{ display: 'flex', alignItems: 'center', width: 120, height: 28, borderRadius: 8, borderWidth: 1, borderColor: t.border, paddingLeft: 8, paddingRight: 8 }}>
              <Label color={t.text}>Account</Label>
            </div>
          )}
        >
          <MenuLabel>Account</MenuLabel>
          <MenuItem id="rename" icon={N.pencil} label="Rename" shortcut="⌘R" onSelect={pick('rename')} />
          <MenuItem id="copy" icon={glyph(Copy01Icon)} label="Copy link" onSelect={pick('copy')} />
          <MenuSeparator />
          <MenuLabel>Appearance</MenuLabel>
          {(['light', 'dark', 'system'] as const).map((value) => (
            <MenuItem key={value} id={value} label={value[0]!.toUpperCase() + value.slice(1)} checked={theme === value} onSelect={pick(value, () => setTheme(value))} />
          ))}
          <MenuSeparator />
          <MenuCheckboxItem id="hints" testId="menu-item-hints" label="Show hints" checked={hints} onCheckedChange={(next) => { setPicked('hints'); setHints(next) }} />
          <MenuSub id="color" label="Color" testId="menu-sub-trigger">
            {(['blue', 'green', 'rose'] as const).map((value) => (
              <MenuItem key={value} id={value} testId={`menu-item-${value}`} label={value[0]!.toUpperCase() + value.slice(1)} checked={color === value} onSelect={pick(value, () => setColor(value))} />
            ))}
          </MenuSub>
          <MenuSeparator />
          <MenuItem id="remove" testId="menu-item-remove" label="Remove account" destructive onSelect={pick('remove')} />
        </Menu>
      </div>
      <div style={{ position: 'absolute', left: 40, top: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Label color={t.text}>{`picked: ${picked}`}</Label>
        <Label color={t.text}>{`open: ${open ? 'yes' : 'no'}`}</Label>
        <Label color={t.text}>{`state: ${theme} ${hints ? 'hints' : 'nohints'} ${color}`}</Label>
      </div>
    </div>
  )
}
export const sections: Record<string, ComponentType> = { menus: MenuDemo }
