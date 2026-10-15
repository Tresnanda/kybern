import { CheckListIcon, LeftToRightListBulletIcon, Link01Icon, QuoteDownIcon, SourceCodeSquareIcon, TextAlignLeftIcon, TextBoldIcon, TextItalicIcon } from '@hugeicons/core-free-icons'
import { useState } from 'react'
import { glyph, Icon } from '../icons.tsx'
import { Menu, MenuItem, Tip } from '../nav/overlay.tsx'
import { Button, TextField } from '../settings/controls.tsx'
import { Label, useTheme } from '../ui.tsx'
import { BLOCKS } from './blocks.ts'

const icons = { bold: glyph(TextBoldIcon), italic: glyph(TextItalicIcon), checklist: glyph(CheckListIcon), bullet: glyph(LeftToRightListBulletIcon), code: glyph(SourceCodeSquareIcon), quote: glyph(QuoteDownIcon), outline: glyph(TextAlignLeftIcon), link: glyph(Link01Icon) }
export function Toolbar({ disabled, active, format, mark, link, toggleOutline, finish }: { disabled: boolean; active: boolean; format: (kind: string) => void; mark: (marker: string) => void; link: (label: string, href: string) => void; toggleOutline: () => void; finish: () => void }) {
  const t = useTheme()
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')
  const [label, setLabel] = useState('')
  const insert = () => { if (!/^(https?:\/\/|mailto:|tel:|kybern:\/\/)/i.test(href.trim())) return; link(label || href, href.trim()); setLinking(false); setHref(''); setLabel('') }
  const separator = <div style={{ width: 1, height: 16, marginLeft: 3, marginRight: 3, backgroundColor: t.border }} />
  return <div style={{ display: 'flex', alignItems: 'center', gap: 2, borderWidth: 0.5, borderColor: t.border, borderRadius: 10, backgroundColor: t.buttonSecondary, padding: 5 }}>
    {linking ? <><TextField label="Link text" placeholder="Link text" value={label} onChange={setLabel} width={130} /><TextField testId="note-link-url" label="Link address" placeholder="https://…" value={href} onChange={setHref} width={220} onSubmit={insert} /><Button testId="note-link-add" onClick={insert}>Add link</Button><Button onClick={() => setLinking(false)}>Cancel</Button></> : <>
      <Menu testId="note-block-style" trigger={() => <div style={{ padding: 7 }}><Label color={t.text} size={12}>Body ⌄</Label></div>}>{BLOCKS.map((b) => <MenuItem key={b.id} id={b.id} label={b.label} disabled={disabled} onSelect={() => format(b.id)} />)}</Menu>
      {separator}<FormatButton label="Bold" icon={icons.bold} disabled={disabled} onClick={() => mark('**')} /><FormatButton label="Italic" icon={icons.italic} disabled={disabled} onClick={() => mark('*')} />
      {separator}<FormatButton label="Checklist" icon={icons.checklist} disabled={disabled} onClick={() => format('checklist')} /><FormatButton label="Bullet list" icon={icons.bullet} disabled={disabled} onClick={() => format('bullet')} /><FormatButton label="Code block" icon={icons.code} disabled={disabled} onClick={() => format('code')} /><FormatButton label="Quote" icon={icons.quote} disabled={disabled} onClick={() => format('quote')} /><FormatButton label="Add link" icon={icons.link} disabled={disabled} onClick={() => setLinking(true)} />
      {separator}<FormatButton label="Outline" icon={icons.outline} onClick={toggleOutline} />
      {active && <Button testId="note-done-editing" onClick={finish}>Done</Button>}
    </>}
  </div>
}
function FormatButton({ label, icon, disabled, onClick }: { label: string; icon: string; disabled?: boolean; onClick: () => void }) {
  const t = useTheme()
  return <Tip label={label}><div testId={`note-format-${label.toLowerCase().replaceAll(' ', '-')}`} aria-label={label} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onClick() }} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, opacity: disabled ? 0.4 : 1, cursor: 'pointer', hover: { backgroundColor: t.hover }, active: { backgroundColor: t.buttonSecondaryHover } }}><Icon source={icon} size={16} color={t.textSecondary} /></div></Tip>
}
