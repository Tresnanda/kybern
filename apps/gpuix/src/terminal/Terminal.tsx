import { readClipboardText } from '../platform/os.ts'
import { shellExecutableLabel } from './title.ts'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuix, type PublicInstance, type EventPayload } from '@gpuix/react'
import type { TerminalInfo, TerminalOutputNotification, TerminalExitedNotification, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { localClient, threadClient, useApp } from '../state.ts'
import { clientFor, glyphOfMachine, useMachines } from '../machines/index.ts'
import { readClipboardFrom } from '../machines/clipboard.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { clipboardSources, type SendTarget } from '../../../../packages/kybern-client/src/machineUtilities.ts'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { ContextMenu, Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from '../nav/overlay.tsx'
import { SidebarIconButton } from '../sidebar/rows.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { copyText } from '../transcript/store.ts'
import { N } from '../nav/glyphs.ts'
import { Icon } from '../icons.tsx'
import { DOCK_ICONS } from '../dock/icons.ts'
import { Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { ErrorLine } from '../dock/parts.tsx'
import { Tabs, type TabsItem } from '../kit/Tabs.tsx'
import { DURATION, EASE, revealTransform } from '../motion/kit.tsx'
import { fadeTo } from '../shell/motion.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { noteTerminalFocus } from './focus.ts'
import { createInputStream, type InputStream } from './inputStream.ts'
import { VT, cellWidth, type Line, type Pen } from './vt.ts'
import { glyphRects, isCustomGlyph } from './glyphs.ts'
import { allRange, lineRange, selectedText, selectionByIndex, selectionColumns, wordRange, type TerminalSelection } from './selection.ts'
import { observeElementBounds } from '../native/layout.ts'
import { terminalCommand, terminalKey, terminalPaste, terminalMouse, terminalViewportKey, type TerminalMouseEvent } from './keys.ts'
import { SHORTCUT } from '../platform/keys.ts'
import { Utf8ToUtf32 } from './utf8.ts'
import { fitTerminal, PANE_BOTTOM, PANE_X, XTERM_X, XTERM_Y } from './fit.ts'
import { blend, indexedColor, parseCss, terminalColors, terminalPalette, type TerminalPalette } from './palette.ts'

// xterm.js on the desktop: JetBrains Mono 12px, line height 1.35. Its cell is 7 x 21.5 CSS px
// at 2x (device width floor(7.2 * 2) = 14, height floor(32 * 1.35) = 43). The font is sized so a
// glyph advances exactly one cell, because a run is one native text node and must not drift.
const FONT = 'JetBrains Mono'
// `fontWeight: 300`, `fontWeightBold: 500`; italic faces are registered as their own family (main.tsx).
const FONT_ITALIC = 'JetBrains Mono Italic', WEIGHT = 300, WEIGHT_BOLD = 500
const CELL = 7, ROW = 21.5, FONT_SIZE = 12 * CELL / 7.2
// Desktop pane padding plus `.xterm` padding (see fit.ts): text starts 24px from the dock edge and 13.6px below the tab row.
// The grid is exactly rows × ROW from the top, like xterm's viewport; the remainder stays below it.
const PAD_X = PANE_X + XTERM_X, PAD_TOP = 13.6, PAD_BOTTOM = PANE_BOTTOM + XTERM_Y
const BLINK_MS = 600
const OUTPUT_MS = 33

/** What the tab shows: shells announce `user@host:/path` and only the folder matters (desktop `onTitle`). */
function shortTitle(raw: string) {
  const title = raw.trim()
  if (!title) return ''
  const shell = shellExecutableLabel(title)
  if (shell) return shell
  const match = /^[^@\s]+@[^:]+:(.+)$/.exec(title)
  const path = match?.[1] ?? title
  const name = path.replace(/\/+$/, '').split('/').pop() || path
  return name.length > 32 ? `${name.slice(0, 31)}…` : name
}

interface Tab { info: TerminalInfo; title: string; kind: string }
export function TerminalPane({ threadId, width }: { threadId: string; width: number }) {
  const t = useTheme()
  const connected = useApp(s => s.status === 'open')
  const [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [selected, select] = useState<string | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const kinds = useRef(new Map<string, string>())
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const current = tabs.find(tab => tab.id === selected) ?? tabs[tabs.length - 1]
  const cols = () => Math.max(20, fitTerminal(width, 0, CELL, ROW).cols)
  const refresh = async () => {
    try { const result = await threadClient(threadId)!.call('terminals.list', { thread_id: threadId }); if (alive.current) setTabs(result.terminals) }
    catch (e) { if (alive.current) setError(String(e)) }
  }
  const create = async (command?: string[], kind = 'shell') => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const tab = await threadClient(threadId)!.call('terminals.create', { thread_id: threadId, cols: cols(), rows: 24, ...(command ? { command } : {}) })
      kinds.current.set(tab.id, kind)
      if (alive.current) { setTabs(old => [...old.filter(t => t.id !== tab.id), tab]); select(tab.id) }
    } catch (e) { if (alive.current) setError(String(e)) } finally { if (alive.current) setBusy(false) }
  }
  const close = async (id: string) => {
    try {
      await threadClient(threadId)!.call('terminals.close', { terminal_id: id })
      const left = tabs.filter(t => t.id !== id)
      setTabs(left); if (selected === id) select(null)
      // The pane always shows a live terminal: closing the last tab opens a fresh shell.
      if (!left.length) void create()
    } catch (e) { setError(String(e)) }
  }
  useEffect(() => {
    alive.current = true
    if (!connected) return
    let live = true
    const client = threadClient(threadId)!
    void client.call('terminals.list', { thread_id: threadId }).then(async result => {
      if (!live) return
      setTabs(result.terminals)
      if (!result.terminals.length) await create()
    }).catch(e => { if (live) setError(String(e)) })
    void localClient()!.call('providers.list', {}).then(result => { if (live) setProviders(result.providers) }).catch(() => {})
    const off = client.onNotification('terminal.exited', () => void refresh())
    return () => { live = false; alive.current = false; off() }
  }, [threadId, connected])
  // The tab switched to by the pointer fades in over 150 ms (opacity only: terminal text must not shift). The first tab, and a tab
  // that is only the first to be selected after the list loaded, render plainly.
  const shown = useRef<string | undefined>(undefined)
  const fadeFor = useRef<string | null>(null)
  if (shown.current !== current?.id) {
    fadeFor.current = shown.current !== undefined && current ? current.id : null
    shown.current = current?.id
  }
  const label = (tab: TerminalInfo, index: number) => {
    const kind = kinds.current.get(tab.id)
    if (kind && kind !== 'shell') return `${providers.find(p => p.kind === kind)?.display_name ?? kind} ${tabs.filter((x, i) => i <= index && (kinds.current.get(x.id) ?? 'shell') === kind).length}`
    if (titles[tab.id]) return titles[tab.id]!
    if (/^(zsh|bash|sh|fish)$/.test(tab.title)) return tab.cwd.split('/').filter(Boolean).at(-1) || 'Terminal'
    return shellExecutableLabel(tab.title) ?? (tab.title || (index ? `Terminal ${index + 1}` : 'Terminal'))
  }
  return <div testId="dock-terminal" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', minHeight: 36, gap: 4, paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4, flexShrink: 0 }}>
      {/* The kit strip at the sm size (ADE-55 §2.7). In a thread, each session is its own tab beside the chat; this pane hosts several. */}
      <Tabs testId="terminal-tabs" size="sm" minWidth={0} underlineGap={6}
        items={tabs.map((tab, index): TabsItem => { const kind = kinds.current.get(tab.id) ?? 'shell'; return { key: tab.id, label: label(tab, index), testId: `terminal-tab-${tab.id}`, closeTestId: `terminal-tab-close-${tab.id}`, ...(kind === 'shell' ? { icon: DOCK_ICONS.terminal } : { mark: kind }) } })}
        active={current?.id ?? null} onSelect={select} onClose={(id) => void close(id)}
        trailing={<SidebarIconButton icon={N.plus} size="sm" label="New terminal" tooltip="New terminal" tooltipSide="bottom" testId="terminal-new" onClick={() => { if (!busy) void create() }} />} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <Menu align="end" testId="terminal-cli" width={208} trigger={() => <SidebarIconButton icon={DOCK_ICONS.terminal} size="sm" label="Open an agent CLI" tooltip="Open an agent CLI" tooltipSide="bottom" />}>
          <MenuLabel>Open in a new tab</MenuLabel>
          <MenuItem id="shell" icon={DOCK_ICONS.terminal} label="Shell" onSelect={() => void create()} />
          {providers.some(p => p.available && p.binary_path) && <><MenuSeparator /><MenuLabel>Agent CLIs in this environment</MenuLabel></>}
          {providers.filter(p => p.available && p.binary_path).map(p => <MenuItem key={p.kind} id={p.kind} iconNode={<ProviderMark kind={p.kind} size={14} />} label={p.display_name} onSelect={() => void create([p.binary_path!], p.kind)} />)}
        </Menu>
        <div style={{ opacity: current ? 1 : 0.45 }}><SidebarIconButton icon={DOCK_ICONS.trash} size="sm" label="Close active terminal tab" tooltip="Close terminal" tooltipSide="bottom" testId={current ? `terminal-close-${current.id}` : undefined} onClick={() => { if (current) void close(current.id) }} /></div>
      </div>
    </div>
    <ErrorLine error={error} retry={() => void refresh()} />
    {current ? <div key={current.id} paintTransform={PATCHED_NATIVE && fadeFor.current === current.id ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] } } : undefined} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
      <Screen info={current} threadId={threadId} width={width} onTitle={title => setTitles(old => old[current.id] === title ? old : { ...old, [current.id]: title })} onExit={() => void close(current.id)} />
    </div> : <Button style={{ alignSelf: 'flex-start', margin: 8 }} onClick={() => void create()}>Open terminal</Button>}
  </div>
}

interface RowProps {
  line: Line; revision: number; model: VT; palette: TerminalPalette; surface: string; selectionColor: string; cursorColor: string
  cursor: number; cursorShape: 'block' | 'underline' | 'bar' | 'outline'; selection: [number, number] | null
  selectCell: (line: Line, column: number, begin: boolean, end: boolean, clicks: number, shift: boolean) => void
  reportMouse: (line: Line, column: number, event: EventPayload, kind: TerminalMouseEvent['kind']) => boolean
}
function resolveRun(pen: Pen, props: { palette: TerminalPalette; surface: string; model: VT }) {
  const { palette, surface, model } = props
  const color = (value: Pen['fg'], fallback: string, bright = false) => {
    if (value === undefined) return fallback
    if (typeof value === 'string') return value
    // drawBoldTextInBrightColors: bold text in ANSI 0-7 uses the bright 8-15.
    return indexedColor(bright && value < 8 ? value + 8 : value, palette, model.paletteOverrides)
  }
  const defaultFg = model.foregroundOverride ? `rgb(${model.foregroundOverride.join(',')})` : palette.foreground
  const defaultBg = model.backgroundOverride ? `rgb(${model.backgroundOverride.join(',')})` : surface
  let fg = color(pen.fg, defaultFg, !!pen.bold), bg: string | undefined = pen.bg === undefined ? undefined : color(pen.bg, defaultBg)
  if (pen.inverse) { const swap = bg ?? defaultBg; bg = fg; fg = swap }
  if (pen.dim) fg = blend(fg, bg ?? defaultBg, 0.5)
  if (pen.hidden) fg = bg ?? defaultBg
  return { fg, bg }
}
const TerminalLine = memo(function TerminalLine({ line, model, palette, surface, selectionColor, cursorColor, cursor, cursorShape, selection, selectCell, reportMouse }: RowProps) {
  const { renderer } = useGpuix(), row = useRef<PublicInstance | null>(null)
  const x0 = (x: number | undefined) => { const bounds = row.current && renderer?.getElementBounds?.(row.current.id); return bounds && x !== undefined ? x - bounds.x : undefined }
  const column = (x: number | undefined) => { const local = x0(x); return local === undefined ? 0 : Math.max(0, Math.min(model.cols, Math.round(local / CELL))) }
  const mouseColumn = (x: number | undefined) => { const local = x0(x); return local === undefined ? 0 : Math.max(0, Math.min(model.cols - 1, Math.floor(local / CELL))) }
  const cell = (x: number | undefined) => { const local = x0(x); return local === undefined ? 0 : Math.max(0, Math.min(model.cols - 1, Math.floor(local / CELL))) }
  const char = cursor >= 0 && cursorShape === 'block' ? line.chars[cursor] : undefined
  // Box drawing and block glyphs are rectangles (see glyphs.ts); their cells hold a space in the text.
  const runs = []
  let col = 0
  for (const run of model.runs(line)) {
    const { fg, bg } = resolveRun(run.style, { palette, surface, model })
    let plain = '', c = col
    const overlays: { key: string; x: number; y: number; w: number; h: number; alpha?: number }[] = []
    for (const ch of run.text) {
      const cp = ch.codePointAt(0)!, width = cellWidth(ch)
      if (width === 1 && cp >= 0x2500 && cp <= 0x259f && isCustomGlyph(cp) && !run.style.hidden) {
        plain += ' '
        glyphRects(cp, CELL, ROW).forEach((rect, n) => overlays.push({ key: `${c}-${n}`, x: c * CELL + rect.x, y: rect.y, w: rect.w, h: rect.h, alpha: rect.alpha }))
      } else plain += ch
      c += width
    }
    runs.push({ run, plain, overlays, fg, bg })
    col += run.columns
  }
  return <div ref={row} testId={`terminal-line-${line.id}`} onScroll={e => { reportMouse(line, mouseColumn(e.x), e, 'wheel') }}
    onMouseDown={e => { if (!reportMouse(line, mouseColumn(e.x), e, 'down') && e.button === 0) selectCell(line, e.clickCount && e.clickCount > 1 ? cell(e.x) : column(e.x), true, false, e.clickCount ?? 1, !!e.modifiers?.shift) }}
    onMouseMove={e => { if (!reportMouse(line, mouseColumn(e.x), e, 'move') && e.pressedButton === 0) selectCell(line, column(e.x), false, false, 1, false) }}
    onMouseUp={e => { if (!reportMouse(line, mouseColumn(e.x), e, 'up')) selectCell(line, column(e.x), false, true, 1, false) }}
    style={{ display: 'flex', height: ROW, minHeight: ROW, flexShrink: 0, position: 'relative', cursor: model.mouseTracking ? 'default' : 'text' }}>
    {runs.map(({ run, plain, overlays, fg, bg }, i) => <Fragment key={i}>
      <text style={{ width: run.columns * CELL, flexShrink: 0, fontFamily: run.style.italic ? FONT_ITALIC : FONT, fontSize: FONT_SIZE, lineHeight: ROW, color: fg, ...(bg ? { backgroundColor: bg } : {}), fontWeight: run.style.bold ? WEIGHT_BOLD : WEIGHT, ...(run.style.underline || run.style.link ? { textDecoration: 'underline' } : run.style.strike ? { textDecoration: 'line-through' } : {}), whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none' }}>{plain}</text>
      {overlays.map(o => <div key={o.key} style={{ position: 'absolute', left: o.x, top: o.y, width: o.w, height: o.h, backgroundColor: fg, opacity: o.alpha ?? 1, pointerEvents: 'none' }} />)}
    </Fragment>)}
    {selection && selection[1] > selection[0] && <div style={{ position: 'absolute', top: 0, height: ROW, left: selection[0] * CELL, width: (selection[1] - selection[0]) * CELL, backgroundColor: selectionColor, pointerEvents: 'none' }} />}
    {cursor >= 0 && cursorShape === 'bar' && <div style={{ position: 'absolute', left: cursor * CELL, top: 0, width: 1, height: ROW, backgroundColor: cursorColor, pointerEvents: 'none' }} />}
    {cursor >= 0 && cursorShape === 'outline' && <div style={{ position: 'absolute', left: cursor * CELL, top: 0, width: CELL, height: ROW, borderWidth: 1, borderColor: cursorColor, pointerEvents: 'none' }} />}
    {cursor >= 0 && cursorShape === 'underline' && <div style={{ position: 'absolute', left: cursor * CELL, top: ROW - 1, width: CELL, height: 1, backgroundColor: cursorColor, pointerEvents: 'none' }} />}
    {cursor >= 0 && cursorShape === 'block' && <div style={{ position: 'absolute', left: cursor * CELL, top: 0, width: CELL * (char !== undefined && char !== '' && model.runs(line).length ? 1 : 1), height: ROW, backgroundColor: cursorColor, pointerEvents: 'none', display: 'flex' }}><text style={{ fontFamily: FONT, fontSize: FONT_SIZE, fontWeight: WEIGHT, lineHeight: ROW, color: surface, whiteSpace: 'nowrap', userSelect: 'none' }}>{!char || char === '\0' ? ' ' : char}</text></div>}
  </div>
})

/** Also embedded by the Add account sheet's sign-in terminal, which keeps its tab when the program ends. */
export function Screen({ info, threadId, machineId, width, onTitle, onExit }: { info: TerminalInfo; threadId?: string; /** A terminal on another machine: its calls and notifications go to that machine's client. */ machineId?: string; width: number; onTitle?: (title: string) => void; onExit?: () => void }) {
  const t = useTheme()
  const clientOf = () => { try { return machineId ? clientFor(machineId) : threadClient(threadId) } catch { return null } }
  const palette = terminalPalette(t.variant)
  const { renderer } = useGpuix()
  const host = useRef<PublicInstance | null>(null), list = useRef<PublicInstance | null>(null)
  // Keystrokes, pastes and the program's own query replies share one ordered stream (see inputStream.ts).
  const input = useRef<InputStream | null>(null)
  const model = useMemo(() => new VT(info.cols, info.rows, 5000, 1_000_000, response => { input.current?.push(Buffer.from(response)) }), [info.id])
  model.colors = terminalColors(t.variant, t.surface)
  model.blinkOption = true // the desktop terminal sets `cursorBlink: true`
  const [version, update] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [exit, setExit] = useState<number | null>(info.alive ? null : info.exit_code ?? 0)
  const [range, setRange] = useState({ start: 0, end: 48 })
  const follow = useRef(true)
  const [selection, setSelection] = useState<TerminalSelection | null>(null)
  const selecting = useRef(false)
  const wheelDelta = useRef(0), arrowDelta = useRef(0)
  const [focused, setFocused] = useState(false)
  // A terminal that unmounts while focused would otherwise hold the count up.
  useEffect(() => () => { if (model.focused) { model.focused = false; noteTerminalFocus(false) } }, [model])
  const [blinkOn, setBlinkOn] = useState(true)
  const titleRef = useRef(onTitle); titleRef.current = onTitle
  const exitRef = useRef(onExit); exitRef.current = onExit
  const lines = model.mouseTracking ? model.screen : model.lines()
  const selectCell = useCallback((line: Line, column: number, begin: boolean, end: boolean, clicks: number, shift: boolean) => {
    const all = model.mouseTracking ? model.screen : model.lines()
    if (begin) {
      follow.current = false
      const index = all.indexOf(line)
      if (clicks >= 3) { selecting.current = false; setSelection(lineRange(all, index, model.cols)); return }
      if (clicks === 2) { selecting.current = false; setSelection(wordRange(all, index, column, model.cols)); return }
      selecting.current = true
      setSelection(previous => shift && previous ? { ...previous, head: { line: line.id, column } } : { anchor: { line: line.id, column }, head: { line: line.id, column } })
    } else if (selecting.current) setSelection(previous => previous ? { ...previous, head: { line: line.id, column } } : null)
    if (end) selecting.current = false
  }, [model])
  const [search, setSearch] = useState<string | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [match, setMatch] = useState(-1)
  const find = (query: string, backwards = false, from = match) => {
    setSearch(query)
    const rows = model.lines(), needle = query.toLocaleLowerCase()
    if (!needle) { setMatch(-1); return }
    for (let step = 1; step <= rows.length; step++) {
      const index = ((from < 0 ? (backwards ? 0 : -1) : from) + (backwards ? -step : step) + rows.length * 2) % rows.length
      if (rows[index]!.chars.map(c => c === '\0' ? ' ' : c).join('').toLocaleLowerCase().includes(needle)) {
        follow.current = false; setMatch(index)
        setRange({ start: Math.max(0, index - 4), end: Math.min(rows.length, index + model.rows + 4) })
        if (list.current) renderer?.scrollToItem?.(list.current.id, index)
        return
      }
    }
    setMatch(-1)
  }
  const send = (text: string, encoding: 'utf8' | 'latin1' = 'utf8') => { if (text) input.current?.push(Buffer.from(text, encoding)) }
  useEffect(() => {
    const stream = createInputStream(data => { const client = clientOf(); return client ? client.call('terminals.input', { terminal_id: info.id, data }) : Promise.reject(new Error('This machine is not reachable. Reopen the terminal when it is back.')) }, e => setError(String(e)))
    input.current = stream
    return () => { stream.close(); if (input.current === stream) input.current = null }
  }, [info.id, machineId, threadId])
  /** Fits the model and the pty to the pane; resolves when the daemon has the new size. */
  const fit = (): Promise<void> => {
    const bounds = host.current && renderer?.getElementBounds?.(host.current.id)
    if (!bounds) return Promise.resolve()
    const { cols, rows } = fitTerminal(bounds.width, bounds.height, CELL, ROW)
    if (cols === model.cols && rows === model.rows) return Promise.resolve()
    model.resize(cols, rows); update(v => v + 1)
    return Promise.resolve(clientOf()?.call('terminals.resize', { terminal_id: info.id, cols: model.cols, rows: model.rows })).then(() => {}, e => { setError(String(e)) })
  }
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, syncGuard: ReturnType<typeof setTimeout> | undefined, closing: ReturnType<typeof setTimeout> | undefined
    const decoder = new Utf8ToUtf32()
    const client = clientOf()
    if (!client) { setError('This machine is not reachable. Reopen the terminal when it is back.'); return }
    model.titleChanged = title => { const short = shortTitle(title); if (short) titleRef.current?.(short) }
    const changed = () => {
      // Synchronized output (DECSET 2026) holds the picture until the program finishes its update, for at most a second.
      if (model.synchronizedOutput) { if (!syncGuard) syncGuard = setTimeout(() => { syncGuard = undefined; model.synchronizedOutput = false; if (live) update(v => v + 1) }, 1000); return }
      if (syncGuard) { clearTimeout(syncGuard); syncGuard = undefined }
      if (!timer && isWindowVisible()) timer = setTimeout(() => { timer = undefined; if (live) update(v => v + 1) }, OUTPUT_MS)
    }
    const output = client.onNotification('terminal.output', params => { const output = params as TerminalOutputNotification; if (output.terminal_id === info.id) { model.write(decoder.decodeString(Buffer.from(output.data, 'base64'))); changed() } })
    const exited = client.onNotification('terminal.exited', params => {
      const event = params as TerminalExitedNotification
      if (event.terminal_id !== info.id) return
      model.write(`\r\n\x1b[2m[process exited${event.exit_code != null ? ` with ${event.exit_code}` : ''}]\x1b[0m\r\n`)
      setExit(event.exit_code ?? 0); update(v => v + 1)
      // A tab whose program ended closes itself.
      if (exitRef.current) closing = setTimeout(() => { if (live) exitRef.current?.() }, 600)
    })
    // The pty takes the pane's size before the replay starts, so the scrollback is drawn at the width it is shown at (a replay at
    // the old width, resized afterwards, scrambled lines on a remote terminal).
    const attach = () => fit().then(() => client.call('terminals.subscribe', { terminal_id: info.id, replay: true })).then(() => { if (live) { void fit(); update(v => v + 1); if (host.current) renderer?.focusElement?.(host.current.id) } }).catch(e => { if (live) setError(String(e)) })
    // The daemon dropped output for this client: start over from its replay.
    const lagged = client.onNotification('terminal.lagged', params => { if ((params as { terminal_id: string }).terminal_id === info.id) { model.write('\x1bc'); void attach() } })
    const visibility = onWindowVisibility(shown => { if (shown) { update(v => v + 1); fit() } else { clearTimeout(timer); timer = undefined } })
    void attach()
    return () => { live = false; clearTimeout(timer); clearTimeout(syncGuard); clearTimeout(closing); output(); exited(); lagged(); visibility(); void client.call('terminals.unsubscribe', { terminal_id: info.id }).catch(() => {}) }
  }, [info.id, model])
  useEffect(() => {
    if (!renderer || !host.current) return
    return observeElementBounds(renderer, host.current.id, event => { if (event.rect) fit() })
  }, [renderer, model])
  // The cursor blinks only while the terminal has focus, the window shows and motion is allowed; typing restarts it solid.
  const blink = (model.cursorBlink ?? model.blinkOption) && focused && !REDUCED_MOTION && model.cursorVisible
  const [restart, setRestart] = useState(0)
  useEffect(() => {
    setBlinkOn(true)
    if (!blink) return
    let on = true
    const timer = setInterval(() => { if (!isWindowVisible()) return; on = !on; setBlinkOn(on) }, BLINK_MS)
    return () => clearInterval(timer)
  }, [blink, restart])
  const indexedSelection = selectionByIndex(lines, selection)
  useEffect(() => { if (follow.current && list.current) { setRange({ start: Math.max(0, lines.length - model.rows - 8), end: lines.length }); renderer?.scrollToItem?.(list.current.id, Math.max(0, lines.length - model.rows)) } }, [version])
  const start = Math.min(range.start, Math.max(0, lines.length - 1)), end = Math.min(lines.length, Math.max(start + 1, range.end))
  const paste = () => void readClipboardText().then(
    (stdout) => {
      // xterm.js turns pasted newlines into carriage returns.
      follow.current = true; send(terminalPaste(stdout.replace(/\r?\n/g, '\r'), model.bracketedPaste))
    },
    (error) => setError(String(error instanceof Error ? error.message : error)),
  )
  const machines = useMachines()
  const pasteFrom = (source: SendTarget) => void readClipboardFrom(source).then((text) => { if (text !== null) { follow.current = true; send(terminalPaste(text.replace(/\r?\n/g, '\r'), model.bracketedPaste)) } })
  const copy = () => { const text = selectedText(model.lines(), selection, model.cols); if (text) copyText(text) }
  const cursorLine = (model.alternate || model.mouseTracking ? 0 : model.history.length) + model.y
  const reportMouse = (line: Line, column: number, event: EventPayload, kind: TerminalMouseEvent['kind']) => {
    if (kind === 'wheel' && model.alternate && !model.mouseTracking && !event.modifiers?.shift) {
      // xterm.js: in the alternate buffer the wheel moves the cursor, three lines a notch, in bursts the trackpad softens.
      const pixels = event.precise ? (event.deltaY ?? 0) : (event.deltaY ?? 0) * 20
      let amount = pixels / ROW
      if (Math.abs(pixels) < 50) amount *= 0.3
      arrowDelta.current += amount
      const count = Math.min(20, Math.floor(Math.abs(arrowDelta.current)))
      arrowDelta.current %= 1
      if (count && exit === null) send((model.applicationCursor ? '\x1bO' : '\x1b[') .concat(pixels > 0 ? 'B' : 'A').repeat(count))
      return true
    }
    const row = model.screen.indexOf(line)
    const text = terminalMouse({ kind, column: Math.min(column, model.cols - 1), row, button: kind === 'move' ? event.pressedButton : event.button, deltaY: event.deltaY, modifiers: event.modifiers, px: (event.x ?? 0), py: (event.y ?? 0) }, model)
    if (text && exit === null) {
      let count = 1
      if (kind === 'wheel') {
        // The pinned native bridge reports pixels in both modes; line-based
        // wheel deltas are multiplied by its 20px default line height.
        wheelDelta.current += (event.deltaY ?? 0) / (event.precise ? ROW : 20)
        count = Math.min(20, Math.floor(Math.abs(wheelDelta.current)))
        wheelDelta.current -= Math.sign(wheelDelta.current) * count
      }
      if (count) send(text.repeat(count), model.mouseSgr ? 'utf8' : 'latin1')
      return true
    }
    return false
  }
  // Unfocused, xterm.js draws `cursorInactiveStyle: 'outline'` (a 1px box inside the cell) and does not blink.
  const shape = focused ? model.cursorShape ?? 'bar' : 'outline'
  const cursorVisible = model.cursorVisible && model.cursorInitialized && exit === null && (!focused || blinkOn)
  const renderLine = (line: Line, index: number) => <TerminalLine key={line.id} line={line} revision={line.revision} model={model} palette={palette} surface={t.surface} selectionColor={palette.selection} cursorColor={model.cursorOverride ? `rgb(${model.cursorOverride.join(',')})` : palette.cursor} selection={selectionColumns(indexedSelection, index, model.cols)} selectCell={selectCell} reportMouse={reportMouse} cursorShape={shape} cursor={cursorVisible && index === cursorLine ? Math.min(model.x, model.cols - 1) : -1} />
  return <>
    <ErrorLine error={error} />
    {search !== null && <div style={{ display: 'flex', alignItems: 'center', height: 32, gap: 4, paddingLeft: 8 }}>
      <TextField testId="terminal-search" autoFocus label="Search terminal scrollback" value={search} placeholder="Search scrollback…" onChange={v => { find(v, false, -1) }} onSubmit={() => find(search)} onKeyDown={e => { if (e.key === 'escape') { setSearch(null); if (host.current) renderer?.focusElement?.(host.current.id) } }} shell={{ flexGrow: 1 }} />
      <Label color={t.textSecondary} size={10}>{match < 0 ? 'No match' : `Line ${match + 1}`}</Label><Button variant="ghost" size="sm" label="Previous match" onClick={() => find(search, true)}>↑</Button><Button variant="ghost" size="sm" label="Next match" onClick={() => find(search)}>↓</Button><Button variant="ghost" size="sm" onClick={() => setSearch(null)}>Close</Button>
    </div>}
    <div ref={host} testId="terminal-screen" tabIndex={0} role="textbox" aria-label="Terminal"
      onFocus={() => { if (!model.focused) noteTerminalFocus(true); model.focused = true; model.cursorInitialized = true; setFocused(true); if (model.focusReporting) send('\x1b[I') }}
      onBlur={() => { if (model.focused) noteTerminalFocus(false); model.focused = false; setFocused(false); if (model.focusReporting) send('\x1b[O') }}
      onAuxClick={e => { if ((!model.mouseTracking || e.modifiers?.shift) && (e.isRightClick || e.button === 2)) setMenuAt({ x: e.x ?? 0, y: e.y ?? 0 }) }}
      onMouseUp={() => { selecting.current = false }} onMouseDownOutside={() => { selecting.current = false }}
      onClick={() => { if (host.current) renderer?.focusElement?.(host.current.id); fit() }}
      onKeyDown={e => {
        const action = terminalViewportKey(e)
        if (action === 'selectall') { setSelection(allRange(model.lines(), model.cols)); return }
        if (action === 'pageup' || action === 'pagedown') { follow.current = false; const at = Math.max(0, Math.min(lines.length - 1, (range.start + (action === 'pageup' ? -model.rows : model.rows)))); if (list.current) renderer?.scrollToItem?.(list.current.id, at); return }
        const command = terminalCommand(e)
        if (command === 'copy') copy(); else if (command === 'paste') paste(); else if (command === 'find') setSearch(''); else if (command === 'latest') { follow.current = true; update(v => v + 1) }
        // ⌘ never reaches the shell (off macOS that is the Windows / Super key).
        if (command || e.modifiers?.cmd) return
        const text = terminalKey(e, model.applicationCursor)
        if (text !== null) { e.preventDefault() /* Tab belongs to the shell, not window focus navigation */; follow.current = true; setSelection(null); setRestart(n => n + 1); send(text) }
      }}
      style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: PAD_X, paddingRight: PAD_X, paddingTop: PAD_TOP, paddingBottom: PAD_BOTTOM, backgroundColor: t.content }}>
      {model.mouseTracking ? <div testId="terminal-mouse-screen" style={{ display: 'flex', flexDirection: 'column', height: model.rows * ROW, flexShrink: 1, minHeight: 0, overflow: 'hidden' }}>{lines.map(renderLine)}</div> : <virtual-list ref={list} testId="terminal-lines" itemCount={lines.length} windowStart={start} estimatedItemHeight={ROW} overdraw={ROW * 4} onVisibleRange={e => { const a = e.startIndex ?? 0, b = e.endIndex ?? a + 40; setRange(old => old.start === Math.max(0, a - 4) && old.end === Math.min(lines.length, b + 4) ? old : { start: Math.max(0, a - 4), end: Math.min(lines.length, b + 4) }); follow.current = b >= lines.length - 1 }} style={{ height: model.rows * ROW, flexShrink: 1, minHeight: 0, width: '100%' }}>
        {lines.slice(start, end).map((line, i) => renderLine(line, start + i))}
      </virtual-list>}
    </div>
    {menuAt && <ContextMenu at={menuAt} onClose={() => setMenuAt(null)} testId="terminal-menu">
      <MenuItem id="find" testId="terminal-find" label="Find" shortcut={SHORTCUT.terminalFind} onSelect={() => setSearch('')} />
      <MenuItem id="copy" testId="terminal-copy" label="Copy" shortcut={SHORTCUT.terminalCopy} onSelect={copy} />
      <MenuItem id="paste" label="Paste" shortcut={SHORTCUT.terminalPaste} disabled={exit !== null} onSelect={paste} />
      {clipboardSources(machines).length > 0 && <MenuSub id="paste-from" label="Paste from…" testId="terminal-paste-from" width={216} disabled={exit !== null}>
        {clipboardSources(machines).map((source) => <MenuItem key={source.machineId} id={`paste-from-${source.machineId}`} testId={`terminal-paste-from-${source.machineId}`} iconNode={<MachineBadge glyph={glyphOfMachine(source.machineId)} size={16} />} label={source.name} disabled={exit !== null} onSelect={() => pasteFrom(source)} />)}
      </MenuSub>}
      <MenuItem id="latest" testId="terminal-bottom" label="Scroll to latest" shortcut={SHORTCUT.terminalLatest} onSelect={() => { follow.current = true; update(v => v + 1) }} />
    </ContextMenu>}
  </>
}
void parseCss
