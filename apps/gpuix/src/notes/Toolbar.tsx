import { Image01Icon, CheckListIcon, LeftToRightListBulletIcon, Link01Icon, QuoteDownIcon, SourceCodeSquareIcon, TextAlignLeftIcon, TextBoldIcon, TextItalicIcon } from '@hugeicons/core-free-icons'
import { useState } from 'react'
import { glyph, Icon } from '../icons.tsx'
import { Menu, MenuItem, Tip } from '../nav/overlay.tsx'
import { Button, TextField } from '../settings/controls.tsx'
import { Label, ink, useTheme } from '../ui.tsx'
import { over } from '../theme.ts'
import { N } from '../nav/glyphs.ts'
import { NOTES_UI, notesTokens } from './kit.tsx'
import { BLOCKS } from './blocks.ts'

const icons = { bold: glyph(TextBoldIcon), italic: glyph(TextItalicIcon), checklist: glyph(CheckListIcon), bullet: glyph(LeftToRightListBulletIcon), code: glyph(SourceCodeSquareIcon), quote: glyph(QuoteDownIcon), outline: glyph(TextAlignLeftIcon), link: glyph(Link01Icon), image: glyph(Image01Icon) }
export function Toolbar({ disabled, active, format, mark, link, toggleOutline, outlineOn, finish, image, blockLabel = 'Body' }: { blockLabel?: string; outlineOn?: boolean; image?: () => void; disabled: boolean; active: boolean; format: (kind: string) => void; mark: (marker: string) => void; link: (label: string, href: string) => void; toggleOutline?: () => void; finish: () => void }) {
  const t = useTheme()
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')
  const [label, setLabel] = useState('')
  const insert = () => { if (!/^(https?:\/\/|mailto:|tel:|kybern:\/\/)/i.test(href.trim())) return; link(label || href, href.trim()); setLinking(false); setHref(''); setLabel('') }
  const k = notesTokens(t)
  const dark = t.variant === 'dark'
  const separator = <div style={{ width: 1, height: 16, marginLeft: 4, marginRight: 4, backgroundColor: k.hair }} />
  return <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 38, paddingLeft: 5, paddingRight: 5, borderRadius: 12, borderWidth: 0.5, borderColor: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)', backgroundColor: dark ? over(ink(t, 0.1176), t.surface) : t.surface, boxShadow: dark ? { offsetX: 0, offsetY: 12, blurRadius: 32, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.6)' } : { offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.2)' } }}>
    {linking ? <><TextField label="Link text" placeholder="Link text" value={label} onChange={setLabel} width={130} /><TextField testId="note-link-url" label="Link address" placeholder="https://…" value={href} onChange={setHref} width={220} onSubmit={insert} /><Button testId="note-link-add" onClick={insert}>Add link</Button><Button onClick={() => setLinking(false)}>Cancel</Button></> : <>
      <Menu testId="note-block-style" sideOffset={8} trigger={() => <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, paddingLeft: 8, paddingRight: 6, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: k.hover } }}><Label color={k.fg1} size={NOTES_UI} lineHeight={21}>{blockLabel}</Label><Icon source={N.chevronDown} size={11} color={ink(t, 0.5)} /></div>}>{BLOCKS.map((b) => <MenuItem key={b.id} id={b.id} label={b.label} disabled={disabled} onSelect={() => format(b.id)} />)}</Menu>
      {separator}<FormatButton label="Bold" icon={icons.bold} disabled={disabled} onClick={() => mark('**')} /><FormatButton label="Italic" icon={icons.italic} disabled={disabled} onClick={() => mark('*')} />
      {separator}<FormatButton label="Checklist" icon={icons.checklist} disabled={disabled} onClick={() => format('checklist')} /><FormatButton label="Bullet list" icon={icons.bullet} disabled={disabled} onClick={() => format('bullet')} /><FormatButton label="Code block" icon={icons.code} disabled={disabled} onClick={() => format('code')} /><FormatButton label="Quote" icon={icons.quote} disabled={disabled} onClick={() => format('quote')} /><FormatButton label="Add link" icon={icons.link} disabled={disabled} onClick={() => setLinking(true)} /> {image && <FormatButton label="Add image" icon={icons.image} disabled={disabled} onClick={image} />}
      {toggleOutline && <>{separator}<FormatButton label="Outline" icon={icons.outline} pressed={outlineOn} onClick={toggleOutline} /></>}
      
      {active && <Button testId="note-done-editing" onClick={finish}>Done</Button>}
    </>}
  </div>
}
function FormatButton({ label, icon, disabled, onClick, pressed }: { label: string; icon: string; disabled?: boolean; onClick: () => void; pressed?: boolean }) {
  const t = useTheme()
  const k = notesTokens(t)
  return <Tip label={label}><div testId={`note-format-${label.toLowerCase().replaceAll(' ', '-')}`} aria-label={label} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onClick() }} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, opacity: disabled ? 0.4 : 1, cursor: 'pointer', backgroundColor: pressed ? k.sel : undefined, hover: { backgroundColor: pressed ? k.sel : t.buttonSecondaryHover } }}><Icon source={icon} size={15} color={pressed ? k.fg : t.textSecondary} /></div></Tip>
}
