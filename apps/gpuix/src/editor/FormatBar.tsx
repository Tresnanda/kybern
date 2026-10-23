// The floating bar over selected text and the bubble over a link (desktop
// `views/notes/FormatBar.tsx`): Turn into, bold, italic, strike, code, link; and
// Open / Edit / Remove while the caret is inside a link. The Notes page formats
// from its toolbar, so there only the link bubble shows.
import { ArrowLeft01Icon, ChevronDownIcon, Link01Icon, SourceCodeIcon, TextBoldIcon, TextItalicIcon, TextStrikethroughIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useEffect, useRef, useState } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { glyph, Icon } from '../icons.tsx'
import { PopupLayer, popoverStyle } from '../composer/Menu.tsx'
import { Tip } from '../nav/overlay.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import type { EditorState } from './RichEditor.tsx'
import { SLASH_ICON } from './icons.ts'
import { TURN_INTO_ITEMS } from './slash.ts'
import { pressTransform } from '../motion/press.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { TextField } from '../kit/Field.tsx'
import type { ControlSize } from '../kit/controls.ts'

const ICONS = {
  bold: glyph(TextBoldIcon), italic: glyph(TextItalicIcon), strike: glyph(TextStrikethroughIcon), code: glyph(SourceCodeIcon),
  link: glyph(Link01Icon), back: glyph(ArrowLeft01Icon), check: glyph(Tick02Icon), chevron: glyph(ChevronDownIcon),
}
type Command = (command: Record<string, unknown>) => unknown

/** A pasted address like "example.com" becomes a link; anything with a scheme is kept (desktop `linkTarget.ts`). */
export function normalizeLinkTarget(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** What a link points at, short enough to read at a glance. */
function linkLabel(href: string): string {
  if (/^kybern:\/\/thread\//i.test(href)) return 'Thread link'
  return href.replace(/^(https?:\/\/|mailto:|tel:)/i, '').replace(/\/$/, '')
}

/** `FormatButton`: a kit `IconButton` (28, or `sm` 24) with the tooltip; `active` is the current mark or block. */
export function FormatButton({ icon, label, shortcut, active, onClick, size = 'md', iconSize = 14, testId }: { icon: string; label: string; shortcut?: string; active?: boolean; onClick: () => void; size?: ControlSize; iconSize?: number; testId?: string }) {
  return (
    <Tip label={shortcut ? `${label} ${shortcut}` : label}>
      <IconButton testId={testId ?? `editor-format-${label.toLowerCase().replaceAll(' ', '-')}`} icon={icon} label={label} size={size} glyph={iconSize} active={active} onClick={onClick} />
    </Tip>
  )
}

function TextButton({ label, onClick, testId, strong }: { label: string; onClick: () => void; testId?: string; strong?: boolean }) {
  return <Button testId={testId} size="sm" variant={strong ? 'secondary' : 'ghost'} onClick={onClick}>{label}</Button>
}

/** The link address field: Back, the address, Apply (Remove when cleared). */
export function LinkField({ initial, command, onDone, width = 224 }: { initial: string; command: Command; onDone: () => void; width?: number }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [value, setValue] = useState(initial)
  const input = useRef<PublicInstance>(null)
  useEffect(() => { if (input.current) renderer?.focusElement?.(input.current.id) }, [])
  const apply = () => {
    const href = normalizeLinkTarget(value)
    command({ cmd: 'link', href: href || null, text: value.trim() })
    command({ cmd: 'focus' })
    onDone()
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <IconButton testId="editor-link-back" icon={ICONS.back} label="Back to formatting" size="sm" glyph={14} onClick={() => { onDone(); command({ cmd: 'focus' }) }} />
      <TextField ref={input} testId="editor-link-address" label="Link address" value={value} placeholder="Paste a link"
        interceptKeys={['escape']}
        onChange={setValue}
        onSubmit={apply}
        onKeyDown={(e) => { if (e.key === 'escape') { e.preventDefault(); onDone(); command({ cmd: 'focus' }) } }}
        theme={{ text: t.text, caret: t.text }}
        width={width} />
      <TextButton testId="editor-link-apply" label={initial && !value.trim() ? 'Remove' : 'Apply'} onClick={apply} strong />
    </div>
  )
}

/** The selection bar (compact surfaces): Turn into ⌄ | B I S code | link. */
export function FormatBar({ state, command }: { state: EditorState; command: Command }) {
  const t = useTheme()
  const [mode, setMode] = useState<'buttons' | 'link' | 'turn'>('buttons')
  // Once the selection is gone the bar is gone; the next one starts on its buttons.
  useEffect(() => { if (state.collapsed && mode !== 'buttons') setMode('buttons') }, [state.collapsed])
  const show = !state.collapsed && !state.inCode && (state.focused || mode !== 'buttons') && state.selection
  if (!show) return null
  const [x, y, w] = state.selection!
  const blockTitle = TURN_INTO_ITEMS.find(item => item.id === state.block)?.title ?? 'Body'
  const run = (cmd: Record<string, unknown>) => { command(cmd); command({ cmd: 'focus' }) }
  const separator = <div style={{ width: 1, height: 16, marginLeft: 2, marginRight: 2, backgroundColor: t.border }} />
  return (
    <PopupLayer testId="editor-format-bar" still position={{ x: x + w / 2, y: y - 8 }} anchor="bottomCenter" kind="menu" side="top"
      style={{ ...popoverStyle(t), display: 'flex', alignItems: 'center', gap: 2, padding: 4 }}>
      {mode === 'link' ? <LinkField initial={state.link?.href ?? ''} command={command} onDone={() => setMode('buttons')} />
        : mode === 'turn' ? <div role="menu" aria-label="Turn into" style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 176 }}>
          {TURN_INTO_ITEMS.map(item => {
            const active = item.id === state.block
            return <div key={item.id} testId={`editor-turn-${item.id}`} role="menuitemradio" aria-selected={active} onClick={() => { if (!active) run({ cmd: 'turnInto', block: item.id }); setMode('buttons') }} paintTransform={pressTransform()}
              style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
              <Icon source={SLASH_ICON[item.icon]} size={14} color={ink(t, 0.8)} />
              <div style={{ flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} truncate>{item.title}</Label></div>
              {active && <Icon source={ICONS.check} size={12} color={t.text} />}
            </div>
          })}
        </div>
          : <>
            <PickerChip quiet size="sm" testId="editor-turn-into" label={`Turn into. Now ${blockTitle}`} maxWidth={120} onClick={() => setMode('turn')}>{blockTitle}</PickerChip>
            {separator}
            <FormatButton icon={ICONS.bold} label="Bold" shortcut="⌘B" active={state.marks.bold} onClick={() => run({ cmd: 'mark', mark: 'bold' })} />
            <FormatButton icon={ICONS.italic} label="Italic" shortcut="⌘I" active={state.marks.italic} onClick={() => run({ cmd: 'mark', mark: 'italic' })} />
            <FormatButton icon={ICONS.strike} label="Strikethrough" shortcut="⌘⇧S" active={state.marks.strike} onClick={() => run({ cmd: 'mark', mark: 'strike' })} />
            <FormatButton icon={ICONS.code} label="Code" shortcut="⌘E" active={state.marks.code} onClick={() => run({ cmd: 'mark', mark: 'code' })} />
            {separator}
            <FormatButton icon={ICONS.link} label={state.link ? 'Edit link' : 'Add link'} active={!!state.link} onClick={() => setMode('link')} />
          </>}
    </PopupLayer>
  )
}

/** Open / Edit / Remove while the caret sits inside a link. */
export function LinkBubble({ state, command, onOpen, onEdit, inBar }: { state: EditorState; command: Command; onOpen: (href: string) => void; onEdit?: () => void; inBar: boolean; tokens?: unknown }) {
  const t = useTheme()
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!state.link) setEditing(false) }, [state.link?.href])
  const anchor = state.caret ?? state.link?.rect
  if (!state.link || !anchor || (!state.focused && !editing) || (!state.collapsed && !editing)) return null
  const [x, y, , h] = anchor
  const href = state.link.href
  return (
    <PopupLayer testId="editor-link-bubble" still position={{ x, y: y + h + 6 }} anchor="topLeft" kind="menu" side="bottom"
      style={{ ...popoverStyle(t), display: 'flex', alignItems: 'center', gap: 2, padding: 4 }}>
      {editing ? <LinkField initial={href} command={command} onDone={() => setEditing(false)} /> : <>
        <div style={{ paddingLeft: 8, paddingRight: 6, maxWidth: 224 }}><Label color={ink(t, t.variant === 'dark' ? 0.58 : 0.6)} size={14} truncate>{linkLabel(href)}</Label></div>
        <TextButton testId="editor-link-open" label="Open" onClick={() => onOpen(href)} />
        <TextButton testId="editor-link-edit" label="Edit" onClick={() => { command({ cmd: 'selectLink' }); if (inBar || !onEdit) setEditing(true); else onEdit() }} />
        <TextButton testId="editor-link-remove" label="Remove" onClick={() => { command({ cmd: 'link', href: null }); command({ cmd: 'focus' }) }} />
      </>}
    </PopupLayer>
  )
}
