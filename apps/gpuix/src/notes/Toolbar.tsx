// The document's floating toolbar (desktop `NoteToolbar.tsx`): one slim material bar
// at the top of the page. Block style (Body ⌄), bold and italic, then checklist,
// bullets, code block, quote, link and image, then the outline. It is the page's
// only formatting control; strikethrough and inline code keep their shortcuts and
// Markdown rules. The link button turns the bar into the link field.
import { CheckListIcon, Image01Icon, LeftToRightListBulletIcon, Link01Icon, QuoteDownIcon, SourceCodeSquareIcon, TextAlignLeftIcon, TextBoldIcon, TextItalicIcon } from '@hugeicons/core-free-icons'
import { useState } from 'react'
import { glyph, Icon } from '../icons.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, ink, useTheme } from '../ui.tsx'
import { over } from '../theme.ts'
import { FormatButton, LinkField } from '../editor/FormatBar.tsx'
import { SLASH_ICON } from '../editor/icons.ts'
import type { EditorState } from '../editor/RichEditor.tsx'
import { TURN_INTO_ITEMS } from '../editor/slash.ts'
import { NOTES_UI, notesTokens } from './kit.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'

const icons = { bold: glyph(TextBoldIcon), italic: glyph(TextItalicIcon), checklist: glyph(CheckListIcon), bullet: glyph(LeftToRightListBulletIcon), code: glyph(SourceCodeSquareIcon), quote: glyph(QuoteDownIcon), outline: glyph(TextAlignLeftIcon), link: glyph(Link01Icon), image: glyph(Image01Icon) }

export function Toolbar({ state, command, outlineOn, toggleOutline, image }: {
  state: EditorState | null
  command: (command: Record<string, unknown>) => unknown
  outlineOn?: boolean
  toggleOutline?: () => void
  image?: () => void
}) {
  const t = useTheme()
  const g = useGlass()
  const k = notesTokens(t)
  const [linking, setLinking] = useState(false)
  const dark = t.variant === 'dark'
  const block = state?.block ?? 'text'
  const blockTitle = TURN_INTO_ITEMS.find(item => item.id === block)?.title ?? 'Body'
  const run = (cmd: Record<string, unknown>) => { command(cmd); command({ cmd: 'focus' }) }
  const toggle = (id: string) => run({ cmd: 'toggle', block: id })
  const separator = <div style={{ width: 1, height: 16, marginLeft: 4, marginRight: 4, backgroundColor: k.hair }} />
  const button = (label: string, icon: string, active: boolean | undefined, onClick: () => void, shortcut?: string, testId?: string) =>
    <FormatButton testId={testId ?? `note-format-${label.toLowerCase().replaceAll(' ', '-')}`} label={label} icon={icon} shortcut={shortcut} active={active} onClick={onClick} iconSize={15} />
  return <div testId="note-toolbar" role="toolbar" aria-label="Format" backdrop={frostBackdrop(g, 'pills', 12)} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2, height: 38, paddingLeft: 5, paddingRight: 5, borderRadius: 12, borderWidth: g.on ? 1 : 0.5, borderColor: g.on ? g.pillRim : dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)', backgroundColor: frostFill(g, 'pills', dark ? over(ink(t, 0.1176), t.surface) : t.surface), ...(g.on ? {} : { boxShadow: dark ? { offsetX: 0, offsetY: 12, blurRadius: 32, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.6)' } : { offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.2)' } }) }}>
    <GlassEdge radius={12} color={g.frostHighlight} />
    {linking ? <LinkField initial={state?.link?.href ?? ''} command={command} onDone={() => setLinking(false)} /> : <>
      <Menu testId="note-block-style" sideOffset={8} minWidth={176} trigger={() => <div aria-label={`Block style. Now ${blockTitle}`} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, paddingLeft: 8, paddingRight: 6, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: k.hover } }}><Label color={k.fg1} size={NOTES_UI} lineHeight={21} truncate style={{ maxWidth: 96 }}>{blockTitle}</Label><Icon source={N.chevronDown} size={11} color={ink(t, 0.5)} /></div>}>
        {TURN_INTO_ITEMS.map(item => <MenuItem key={item.id} id={item.id} testId={`note-turn-${item.id}`} icon={SLASH_ICON[item.icon]} label={item.title} checked={item.id === block} onSelect={() => { if (item.id !== block) run({ cmd: 'turnInto', block: item.id }) }} />)}
      </Menu>
      {separator}
      {button('Bold', icons.bold, state?.marks.bold, () => run({ cmd: 'mark', mark: 'bold' }), '⌘B')}
      {button('Italic', icons.italic, state?.marks.italic, () => run({ cmd: 'mark', mark: 'italic' }), '⌘I')}
      {separator}
      {button('Checklist', icons.checklist, block === 'checklist', () => toggle('checklist'), '⌘⇧9')}
      {button('Bullet list', icons.bullet, block === 'bullet', () => toggle('bullet'), '⌘⇧8')}
      {button('Code block', icons.code, block === 'code', () => toggle('code'), '⌘⌥C')}
      {button('Quote', icons.quote, state?.quote, () => toggle('quote'), '⌘⇧B')}
      {button(state?.link ? 'Edit link' : 'Add link', icons.link, !!state?.link, () => { command({ cmd: 'selectLink' }); setLinking(true) })}
      {image && button('Add image', icons.image, false, image)}
      {toggleOutline && <>{separator}{button(outlineOn ? 'Collapse the outline' : 'Keep the outline open', icons.outline, outlineOn, toggleOutline, undefined, 'note-format-outline')}</>}
    </>}
  </div>
}
