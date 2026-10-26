// What a toolkit would draw for a page, drawn by Kybern on Linux (WP10; WPE WebKit has no toolkit): `<select>` popups
// and context menus as Kybern menus. macOS pages get AppKit's own. Page `alert`/`confirm`/`prompt` show nothing on any
// platform (they answer at once in the host), so a page can never open a Kybern dialog.
import { useEffect, useState } from 'react'
import { ContextMenu, MenuItem, MenuSeparator } from '../nav/overlay.tsx'
import { webHost, type WebMenuItem } from './webview.ts'

type Open =
  | { kind: 'options'; id: string; at: { x: number; y: number }; width: number; items: WebMenuItem[] }
  | { kind: 'context'; id: string; at: { x: number; y: number }; items: WebMenuItem[] }

/** The window point of a point in a document (its last placement). */
function windowPoint(id: string, x = 0, y = 0) {
  const rect = webHost.placement(id)
  return { x: (rect?.x ?? 0) + x, y: (rect?.y ?? 0) + y }
}

export function WebPageUi() {
  const [open, setOpen] = useState<Open | null>(null)
  useEffect(() => webHost.surfaceLibrary ? webHost.subscribe(event => {
    if (event.type === 'optionMenu') setOpen({ kind: 'options', id: event.id, at: windowPoint(event.id, event.x, (event.y ?? 0) + (event.height ?? 0)), width: Math.max(160, event.width ?? 0), items: event.items ?? [] })
    else if (event.type === 'contextMenu') setOpen({ kind: 'context', id: event.id, at: windowPoint(event.id, event.x, event.y), items: event.items ?? [] })
    else if (event.type === 'destroyed') setOpen(current => current?.id === event.id ? null : current)
  }) : undefined, [])
  if (!open) return null
  if (open.kind === 'options') {
    let answered = false
    const pick = (index: number) => { answered = true; webHost.optionMenu(open.id, index); setOpen(null) }
    return <ContextMenu at={open.at} width={open.width} testId="web-option-menu" onClose={() => { if (!answered) webHost.optionMenu(open.id, -1); setOpen(null) }}>
      {open.items.map((item, index) => item.group
        ? <MenuItem key={index} id={`group-${index}`} label={item.label ?? ''} disabled onSelect={() => {}} />
        : <MenuItem key={index} id={`option-${index}`} label={item.label ?? ''} checked={item.selected} disabled={item.enabled === false} onSelect={() => pick(index)} />)}
    </ContextMenu>
  }
  let answered = false
  const pick = (index: number) => { answered = true; webHost.contextMenu(open.id, index); setOpen(null) }
  const items = open.items.filter(item => item.separator || item.label)
  return <ContextMenu at={open.at} testId="web-context-menu" onClose={() => { if (!answered) webHost.contextMenu(open.id, -1); setOpen(null) }}>
    {items.map((item, position) => item.separator
      ? <MenuSeparator key={position} />
      : <MenuItem key={position} id={`context-${item.index}`} label={item.label ?? ''} disabled={item.enabled === false} onSelect={() => pick(item.index ?? -1)} />)}
  </ContextMenu>
}
