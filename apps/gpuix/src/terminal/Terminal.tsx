import { execFile } from 'node:child_process'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import type { TerminalInfo, TerminalOutputNotification, TerminalExitedNotification, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { IconButton } from '../sidebar/rows.tsx'
import { copyText } from '../transcript/store.ts'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { Action, ErrorLine } from '../dock/parts.tsx'
import { VT, type Line, type Pen } from './vt.ts'
import { terminalKey } from './keys.ts'

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
    <div style={{ display: 'flex', alignItems: 'center', height: 36, gap: 4, paddingLeft: 6, paddingRight: 6, flexShrink: 0 }}><div style={{ display: 'flex', flexGrow: 1, minWidth: 0, overflowX: 'scroll', gap: 4 }}>{tabs.map((tab, index) => <div key={tab.id} style={{ display: 'flex', alignItems: 'center', height: 28, flexShrink: 0, borderRadius: 8, backgroundColor: tab.id === current?.id ? t.buttonSecondary : undefined }}><IconButton icon={N.x} label={`Close ${tab.title || 'terminal'}`} size={24} testId={`terminal-close-${tab.id}`} onClick={() => void close(tab.id)} /><Action testId={`terminal-tab-${tab.id}`} onClick={() => select(tab.id)}>{tab.title || (index ? `Terminal ${index + 1}` : 'Terminal')}</Action></div>)}</div><IconButton icon={N.plus} label="New terminal" testId="terminal-new" onClick={() => { if (!busy) void create() }} /><Menu align="end" testId="terminal-cli" trigger={() => <IconButton icon={N.laptop} label="Open an agent CLI" />}><MenuItem id="shell" label="Shell" onSelect={() => void create()} />{providers.filter(p => p.available && p.binary_path).map(p => <MenuItem key={p.kind} id={p.kind} label={p.display_name} onSelect={() => void create([p.binary_path!])} />)}</Menu></div>
    <ErrorLine error={error} retry={() => void refresh()} />
    {current ? <Screen key={current.id} info={current} width={width} /> : <Action onClick={() => void create()}>Open terminal</Action>}
  </div>
}
function Screen({ info, width }: { info: TerminalInfo; width: number }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const windowSize = useWindowSize({ intervalMs: 300 })
  const host = useRef<PublicInstance | null>(null), list = useRef<PublicInstance | null>(null)
  const model = useMemo(() => new VT(info.cols, info.rows, 5000, 1_000_000, response => { void getClient()?.call('terminals.input', { terminal_id: info.id, data: Buffer.from(response).toString('base64') }).catch(() => {}) }), [info.id])
  const [version, update] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [exit, setExit] = useState<number | null>(info.alive ? null : info.exit_code ?? 0)
  const [range, setRange] = useState({ start: 0, end: 48 })
  const follow = useRef(true)
  const send = (text: string) => { if (text) void getClient()!.call('terminals.input', { terminal_id: info.id, data: Buffer.from(text).toString('base64') }).catch(e => setError(String(e))) }
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
  useEffect(() => { const timer = setTimeout(fit, 32); return () => clearTimeout(timer) }, [width, windowSize.width, windowSize.height])
  const lines = model.lines()
  useEffect(() => { if (follow.current && list.current) { setRange({ start: Math.max(0, lines.length - model.rows - 8), end: lines.length }); renderer?.scrollToItem?.(list.current.id, Math.max(0, lines.length - model.rows)) } }, [version])
  const start = Math.min(range.start, Math.max(0, lines.length - 1)), end = Math.min(lines.length, Math.max(start + 1, range.end))
  const paste = () => execFile('pbpaste', (error, stdout) => { if (error) setError(String(error)); else send(model.bracketedPaste ? `\x1b[200~${stdout}\x1b[201~` : stdout) })
  const copy = () => copyText(renderer?.getSelectedText?.() || model.text())
  const cursorLine = (model.alternate ? 0 : model.history.length) + model.y
  return <>
    <ErrorLine error={error} />
    <div ref={host} testId="terminal-screen" tabIndex={0} role="textbox" aria-label="Terminal" onClick={() => { if (host.current) renderer?.focusElement?.(host.current.id); fit() }} onKeyDown={e => {
      if (e.modifiers?.cmd) { if (e.key === 'c') copy(); else if (e.key === 'v') paste(); return }
      const text = terminalKey(e, model.applicationCursor); if (text !== null) { follow.current = true; send(text) }
    }} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 8, paddingRight: 8, paddingTop: 4, backgroundColor: t.surface }}>
      <virtual-list ref={list} testId="terminal-lines" itemCount={lines.length} windowStart={start} estimatedItemHeight={ROW} overdraw={ROW * 4} onVisibleRange={e => { const a = e.startIndex ?? 0, b = e.endIndex ?? a + 40; setRange(old => old.start === Math.max(0, a - 4) && old.end === Math.min(lines.length, b + 4) ? old : { start: Math.max(0, a - 4), end: Math.min(lines.length, b + 4) }); follow.current = b >= lines.length - 1 }} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {lines.slice(start, end).map((line, i) => <TerminalLine key={line.id} line={line} revision={line.revision} model={model} cursor={model.cursorVisible && start + i === cursorLine && exit === null ? Math.min(model.x, model.cols - 1) : -1} />)}
      </virtual-list>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', height: 28, flexShrink: 0, gap: 4 }}><Label color={t.textTertiary} size={10} style={{ flexGrow: 1, paddingLeft: 12 }}>{exit === null ? `${model.cols} × ${model.rows}` : `Process exited (${exit})`}</Label><Action testId="terminal-copy" onClick={copy}>Copy</Action><Action onClick={paste} disabled={exit !== null}>Paste</Action><Action testId="terminal-bottom" onClick={() => { follow.current = true; update(v => v + 1) }}>Latest ↓</Action></div>
  </>
}
const TerminalLine = memo(function TerminalLine({ line, model, cursor }: { line: Line; revision: number; model: VT; cursor: number }) {
  const t = useTheme(), palette = t.variant === 'dark' ? DARK : LIGHT
  return <div style={{ display: 'flex', height: ROW, minHeight: ROW, position: 'relative', pointerEvents: 'none' }}>{model.runs(line).map((run, i) => {
    let fg = color(run.style.fg, palette, t.text), bg = color(run.style.bg, palette, t.surface)
    if (run.style.inverse) [fg, bg] = [bg, fg]
    return <text key={i} style={{ width: run.columns * CELL, flexShrink: 0, fontFamily: 'Menlo', fontSize: 12, lineHeight: ROW, color: fg, backgroundColor: bg, fontWeight: run.style.bold ? 700 : 400, whiteSpace: 'nowrap', userSelect: 'text' }}>{run.text}</text>
  })}{cursor >= 0 && <div style={{ position: 'absolute', left: cursor * CELL, top: 1, width: CELL, height: ROW - 2, borderWidth: 1, borderColor: t.textSecondary, pointerEvents: 'none' }} />}</div>
})
