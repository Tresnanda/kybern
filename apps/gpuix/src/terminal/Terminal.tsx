import { execFile } from 'node:child_process'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuix, type PublicInstance, type EventPayload } from '@gpuix/react'
import type { TerminalInfo, TerminalOutputNotification, TerminalExitedNotification, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { ContextMenu, Menu, MenuItem } from '../nav/overlay.tsx'
import { IconButton } from '../sidebar/rows.tsx'
import { copyText } from '../transcript/store.ts'
import { N } from '../nav/glyphs.ts'
import { Icon } from '../icons.tsx'
import { DOCK_ICONS } from '../dock/icons.ts'
import { Label, useTheme } from '../ui.tsx'
import { Action, ErrorLine } from '../dock/parts.tsx'
import { VT, type Line, type Pen } from './vt.ts'
import { selectedText, selectionByIndex, selectionColumns, type TerminalSelection } from './selection.ts'
import { observeElementBounds } from '../native/layout.ts'
import { terminalKey, terminalPaste, terminalMouse, type TerminalMouseEvent } from './keys.ts'

const ROW = 19, CELL = 7.22 // 12px Menlo; fixed native cells, as xterm's 12px grid.
// Palette from desktop views/Terminal.tsx; app surface remains the background.
const DARK = ['#181e26','#ff7a8e','#86e795','#f4cd72','#89beff','#d0b0ff','#7ce8ed','#d2dae6','#6e7888','#ff7a8e','#86e795','#f4cd72','#89beff','#d0b0ff','#7ce8ed','#edf1f7']
const LIGHT = ['#2c3542','#bf4657','#3c7e56','#927023','#4866a3','#845695','#357f8d','#d2d7df','#707b8c','#bf4657','#3c7e56','#927023','#4866a3','#845695','#357f8d','#1c2129']
function color(value: Pen['fg'], palette: string[], fallback: string) {
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  if (value < 16) return palette[value] ?? fallback
  if (value >= 232) { const c = 8 + (value - 232) * 10; return `rgb(${c},${c},${c})` }
  const i = value - 16, levels = [0,95,135,175,215,255]; return `rgb(${levels[Math.floor(i / 36)]},${levels[Math.floor(i / 6) % 6]},${levels[i % 6]})`
}
export function TerminalPane({ threadId, width }: { threadId: string; width: number }) {
  const t = useTheme()
  const connected = useApp(s => s.status === 'open')
  const [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [selected, select] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const current = tabs.find(tab => tab.id === selected) ?? tabs[0]
  const refresh = async () => {
    try { const result = await getClient()!.call('terminals.list', { thread_id: threadId }); if (alive.current) setTabs(result.terminals) }
    catch (e) { if (alive.current) setError(String(e)) }
  }
  const create = async (command?: string[]) => {
    if (busy) return
    setBusy(true); setError(null)
    try { const tab = await getClient()!.call('terminals.create', { thread_id: threadId, cols: Math.max(20, Math.floor((width - 16) / CELL)), rows: 24, ...(command ? { command } : {}) }); if (alive.current) { setTabs(old => [...old.filter(t => t.id !== tab.id), tab]); select(tab.id) } }
    catch (e) { if (alive.current) setError(String(e)) } finally { if (alive.current) setBusy(false) }
  }
  const close = async (id: string) => {
    try { await getClient()!.call('terminals.close', { terminal_id: id }); setTabs(old => old.filter(t => t.id !== id)); if (selected === id) select(null) }
    catch (e) { setError(String(e)) }
  }
  useEffect(() => {
    alive.current = true
    if (!connected) return
    let live = true
    void getClient()!.call('terminals.list', { thread_id: threadId }).then(async result => {
      if (!live) return
      setTabs(result.terminals)
      if (!result.terminals.length) await create()
    }).catch(e => { if (live) setError(String(e)) })
    void getClient()!.call('providers.list', {}).then(result => { if (live) setProviders(result.providers) }).catch(() => {})
    const off = getClient()!.onNotification('terminal.exited', () => void refresh())
    return () => { live = false; alive.current = false; off() }
  }, [threadId, connected])
  return <div testId="dock-terminal" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', height: 36, gap: 4, paddingLeft: 6, paddingRight: 6, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0, overflowX: 'scroll', gap: 4 }}>{tabs.map((tab, index) => <div key={tab.id} role="button" tabIndex={0} testId={`terminal-tab-${tab.id}`} onClick={() => select(tab.id)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') select(tab.id) }} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, paddingLeft: 8, paddingRight: 8, flexShrink: 0, borderRadius: 6, cursor: 'pointer', backgroundColor: tab.id === current?.id ? t.buttonSecondary : undefined }}><Icon source={DOCK_ICONS.terminal} size={14} color={t.textSecondary} /><Label size={13} color={t.textSecondary}>{/^(zsh|bash|sh|fish)$/.test(tab.title) ? tab.cwd.split('/').filter(Boolean).at(-1) || 'Terminal' : tab.title || (index ? `Terminal ${index + 1}` : 'Terminal')}</Label></div>)}<IconButton icon={N.plus} size={24} label="New terminal" testId="terminal-new" onClick={() => { if (!busy) void create() }} /></div>
      <Menu align="end" testId="terminal-cli" trigger={() => <IconButton icon={DOCK_ICONS.terminal} size={24} label="Open an agent CLI" />}><MenuItem id="shell" label="Shell" onSelect={() => void create()} />{providers.filter(p => p.available && p.binary_path).map(p => <MenuItem key={p.kind} id={p.kind} label={p.display_name} onSelect={() => void create([p.binary_path!])} />)}</Menu>
      {current && <IconButton icon={DOCK_ICONS.trash} size={24} label="Close terminal" testId={`terminal-close-${current.id}`} onClick={() => void close(current.id)} />}
    </div>
    <ErrorLine error={error} retry={() => void refresh()} />
    {current ? <Screen key={current.id} info={current} width={width} /> : <Action onClick={() => void create()}>Open terminal</Action>}
  </div>
}
function Screen({ info, width }: { info: TerminalInfo; width: number }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const host = useRef<PublicInstance | null>(null), list = useRef<PublicInstance | null>(null)
  const model = useMemo(() => new VT(info.cols, info.rows, 5000, 1_000_000, response => { void getClient()?.call('terminals.input', { terminal_id: info.id, data: Buffer.from(response).toString('base64') }).catch(() => {}) }), [info.id])
  const [version, update] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [exit, setExit] = useState<number | null>(info.alive ? null : info.exit_code ?? 0)
  const [range, setRange] = useState({ start: 0, end: 48 })
  const follow = useRef(true)
  const [selection, setSelection] = useState<TerminalSelection | null>(null)
  const selecting = useRef(false)
  const wheelDelta = useRef(0)
  const selectCell = useCallback((line: number, column: number, begin: boolean, end: boolean) => {
    if (begin) { selecting.current = true; follow.current = false; setSelection({ anchor: { line, column }, head: { line, column } }) }
    else if (selecting.current) setSelection(previous => previous ? { ...previous, head: { line, column } } : null)
    if (end) selecting.current = false
  }, [])
  const [search, setSearch] = useState<string | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [match, setMatch] = useState(-1)
  const find = (query: string, backwards = false, from = match) => {
    setSearch(query)
    const rows = model.lines(), needle = query.toLocaleLowerCase()
    if (!needle) { setMatch(-1); return }
    for (let step = 1; step <= rows.length; step++) {
      const index = ((from < 0 ? (backwards ? 0 : -1) : from) + (backwards ? -step : step) + rows.length * 2) % rows.length
      if (rows[index]!.chars.join('').toLocaleLowerCase().includes(needle)) {
        follow.current = false; setMatch(index)
        setRange({ start: Math.max(0, index - 4), end: Math.min(rows.length, index + model.rows + 4) })
        if (list.current) renderer?.scrollToItem?.(list.current.id, index)
        return
      }
    }
    setMatch(-1)
  }
  const send = (text: string, encoding: 'utf8' | 'latin1' = 'utf8') => { if (text) void getClient()!.call('terminals.input', { terminal_id: info.id, data: Buffer.from(text, encoding).toString('base64') }).catch(e => setError(String(e))) }
  const fit = () => {
    const bounds = host.current && renderer?.getElementBounds?.(host.current.id)
    if (!bounds) return
    const cols = Math.max(2, Math.floor((bounds.width - 16) / CELL)), rows = Math.max(2, Math.floor((bounds.height - 8) / ROW))
    if (cols === model.cols && rows === model.rows) return
    model.resize(cols, rows); update(v => v + 1)
    void getClient()!.call('terminals.resize', { terminal_id: info.id, cols: model.cols, rows: model.rows }).catch(e => setError(String(e)))
  }
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const decoder = new TextDecoder()
    const client = getClient()!
    const changed = () => { if (!timer && isWindowVisible()) timer = setTimeout(() => { timer = undefined; if (live) update(v => v + 1) }, 33) }
    const output = client.onNotification('terminal.output', params => { const output = params as TerminalOutputNotification; if (output.terminal_id === info.id) { model.write(decoder.decode(Buffer.from(output.data, 'base64'), { stream: true })); changed() } })
    const exited = client.onNotification('terminal.exited', params => { const event = params as TerminalExitedNotification; if (event.terminal_id === info.id) setExit(event.exit_code ?? 0) })
    const visibility = onWindowVisibility(shown => { if (shown) { update(v => v + 1); fit() } else { clearTimeout(timer); timer = undefined } })
    void client.call('terminals.subscribe', { terminal_id: info.id, replay: true }).then(() => { if (live) { fit(); update(v => v + 1) } }).catch(e => { if (live) setError(String(e)) })
    return () => { live = false; clearTimeout(timer); output(); exited(); visibility(); void client.call('terminals.unsubscribe', { terminal_id: info.id }).catch(() => {}) }
  }, [info.id, model])
  useEffect(() => {
    if (!renderer || !host.current) return
    return observeElementBounds(renderer, host.current.id, event => { if (event.rect) fit() })
  }, [renderer, model])
  const lines = model.mouseTracking ? model.screen : model.lines()
  const indexedSelection = selectionByIndex(lines, selection)
  useEffect(() => { if (follow.current && list.current) { setRange({ start: Math.max(0, lines.length - model.rows - 8), end: lines.length }); renderer?.scrollToItem?.(list.current.id, Math.max(0, lines.length - model.rows)) } }, [version])
  const start = Math.min(range.start, Math.max(0, lines.length - 1)), end = Math.min(lines.length, Math.max(start + 1, range.end))
  const paste = () => execFile('pbpaste', (error, stdout) => { if (error) setError(String(error)); else send(terminalPaste(stdout, model.bracketedPaste)) })
  const copy = () => copyText(selectedText(model.lines(), selection, model.cols) || renderer?.getSelectedText?.() || model.text())
  const cursorLine = (model.alternate || model.mouseTracking ? 0 : model.history.length) + model.y
  const reportMouse = (line: Line, column: number, event: EventPayload, kind: TerminalMouseEvent['kind']) => {
    const row = model.screen.indexOf(line)
    const text = terminalMouse({ kind, column: Math.min(column, model.cols - 1), row, button: kind === 'move' ? event.pressedButton : event.button, deltaY: event.deltaY, modifiers: event.modifiers }, model)
    if (text && exit === null) {
      let count = 1
      if (kind === 'wheel') {
        // The pinned native bridge reports pixels in both modes; line-based
        // wheel deltas are multiplied by its 20px default line height.
        wheelDelta.current += (event.deltaY ?? 0) / (event.precise ? ROW : 20)
        count = Math.min(20, Math.floor(Math.abs(wheelDelta.current)))
        wheelDelta.current -= Math.sign(wheelDelta.current) * count
      }
      if (count) send(text.repeat(count), !model.mouseSgr && !model.mouseUtf8 && !model.mouseUrxvt ? 'latin1' : 'utf8')
      return true
    }
    return false
  }
  const renderLine = (line: Line, index: number) => <TerminalLine key={line.id} line={line} revision={line.revision} model={model} selection={selectionColumns(indexedSelection, index, model.cols)} selectCell={selectCell} reportMouse={reportMouse} cursor={model.cursorVisible && index === cursorLine && exit === null ? Math.min(model.x, model.cols - 1) : -1} />
  return <>
    <ErrorLine error={error} />
    {search !== null && <div style={{ display: 'flex', alignItems: 'center', height: 32, gap: 4, paddingLeft: 8 }}>
      <input testId="terminal-search" autoFocus aria-label="Search terminal scrollback" value={search} placeholder="Search scrollback…" onChange={e => { find(e.value ?? '', false, -1) }} onSubmit={() => find(search)} onKeyDown={e => { if (e.key === 'escape') { setSearch(null); if (host.current) renderer?.focusElement?.(host.current.id) } }} style={{ flexGrow: 1, height: 26, fontSize: 12, color: t.text, backgroundColor: t.buttonSecondary }} />
      <Label color={t.textSecondary} size={10}>{match < 0 ? 'No match' : `Line ${match + 1}`}</Label><Action onClick={() => find(search, true)}>↑</Action><Action onClick={() => find(search)}>↓</Action><Action onClick={() => setSearch(null)}>Close</Action>
    </div>}
    <div ref={host} testId="terminal-screen" tabIndex={0} role="textbox" aria-label="Terminal" onFocus={() => { if (model.focusReporting) send('\x1b[I') }} onBlur={() => { if (model.focusReporting) send('\x1b[O') }} onAuxClick={e => { if ((!model.mouseTracking || e.modifiers?.shift) && (e.isRightClick || e.button === 2)) setMenuAt({ x: e.x ?? 0, y: e.y ?? 0 }) }} onMouseUp={() => { selecting.current = false }} onMouseDownOutside={() => { selecting.current = false }} onClick={() => { if (host.current) renderer?.focusElement?.(host.current.id); fit() }} onKeyDown={e => {
      if (e.modifiers?.cmd) { if (e.key === 'c') copy(); else if (e.key === 'v') paste(); else if (e.key === 'f') setSearch(''); else if (e.key === 'end') { follow.current = true; update(v => v + 1) }; return }
      const text = terminalKey(e, model.applicationCursor); if (text !== null) { follow.current = true; setSelection(null); send(text) }
    }} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 8, paddingRight: 8, paddingTop: 4, backgroundColor: t.surface }}>
      {model.mouseTracking ? <div testId="terminal-mouse-screen" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>{lines.map(renderLine)}</div> : <virtual-list ref={list} testId="terminal-lines" itemCount={lines.length} windowStart={start} estimatedItemHeight={ROW} overdraw={ROW * 4} onVisibleRange={e => { const a = e.startIndex ?? 0, b = e.endIndex ?? a + 40; setRange(old => old.start === Math.max(0, a - 4) && old.end === Math.min(lines.length, b + 4) ? old : { start: Math.max(0, a - 4), end: Math.min(lines.length, b + 4) }); follow.current = b >= lines.length - 1 }} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {lines.slice(start, end).map((line, i) => renderLine(line, start + i))}
      </virtual-list>}
    </div>
    {exit !== null && <Label color={t.textTertiary} size={12} style={{ paddingLeft: 12, paddingBottom: 8 }}>Process exited ({exit})</Label>}
    {menuAt && <ContextMenu at={menuAt} onClose={() => setMenuAt(null)} testId="terminal-menu">
      <MenuItem id="find" testId="terminal-find" label="Find" shortcut="⌘F" onSelect={() => setSearch('')} />
      <MenuItem id="copy" testId="terminal-copy" label="Copy" shortcut="⌘C" onSelect={copy} />
      <MenuItem id="paste" label="Paste" shortcut="⌘V" disabled={exit !== null} onSelect={paste} />
      <MenuItem id="latest" testId="terminal-bottom" label="Scroll to latest" shortcut="⌘End" onSelect={() => { follow.current = true; update(v => v + 1) }} />
    </ContextMenu>}

  </>
}
const TerminalLine = memo(function TerminalLine({ line, model, cursor, selection, selectCell, reportMouse }: { line: Line; revision: number; model: VT; cursor: number; selection: [number, number] | null; selectCell: (line: number, column: number, begin: boolean, end: boolean) => void; reportMouse: (line: Line, column: number, event: EventPayload, kind: TerminalMouseEvent['kind']) => boolean }) {
  const t = useTheme(), palette = t.variant === 'dark' ? DARK : LIGHT
  const { renderer } = useGpuix(), row = useRef<PublicInstance | null>(null)
  const column = (x: number | undefined) => { const bounds = row.current && renderer?.getElementBounds?.(row.current.id); return bounds && x !== undefined ? Math.max(0, Math.min(model.cols, Math.round((x - bounds.x) / CELL))) : 0 }
  const mouseColumn = (x: number | undefined) => { const bounds = row.current && renderer?.getElementBounds?.(row.current.id); return bounds && x !== undefined ? Math.max(0, Math.min(model.cols - 1, Math.floor((x - bounds.x) / CELL))) : 0 }
  return <div ref={row} testId={`terminal-line-${line.id}`} onScroll={e => { reportMouse(line, mouseColumn(e.x), e, 'wheel') }} onMouseDown={e => { if (!reportMouse(line, mouseColumn(e.x), e, 'down') && e.button === 0) selectCell(line.id, column(e.x), true, false) }} onMouseMove={e => { if (!reportMouse(line, mouseColumn(e.x), e, 'move') && e.pressedButton === 0) selectCell(line.id, column(e.x), false, false) }} onMouseUp={e => { if (!reportMouse(line, mouseColumn(e.x), e, 'up')) selectCell(line.id, column(e.x), false, true) }} style={{ display: 'flex', height: ROW, minHeight: ROW, flexShrink: 0, position: 'relative', cursor: model.mouseTracking ? 'default' : 'text' }}>{model.runs(line).map((run, i) => {
    let fg = color(run.style.fg, palette, t.text), bg = color(run.style.bg, palette, t.surface)
    if (run.style.inverse) [fg, bg] = [bg, fg]
    return <text key={i} style={{ width: run.columns * CELL, flexShrink: 0, fontFamily: 'Menlo', fontSize: 12, lineHeight: ROW, color: fg, backgroundColor: bg, fontWeight: run.style.bold ? 700 : 400, whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none' }}>{run.text}</text>
  })}{selection && selection[1] > selection[0] && <div style={{ position: 'absolute', top: 0, height: ROW, left: selection[0] * CELL, width: (selection[1] - selection[0]) * CELL, backgroundColor: t.selected, opacity: 0.6, pointerEvents: 'none' }} />}{cursor >= 0 && <div style={{ position: 'absolute', left: cursor * CELL, top: 1, width: CELL, height: ROW - 2, borderWidth: 1, borderColor: t.textSecondary, pointerEvents: 'none' }} />}</div>
})
