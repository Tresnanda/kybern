import { Icon } from '../icons.tsx'
import { DockSection } from '../dock/Notes.tsx'
import { muted } from '../nav/overlay.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { VIEWPORT_PRESETS, isViewportSizeValid, parseViewportField } from '../../../../packages/kybern-client/src/previewViewport.ts'
import type { PreviewOpenRequestedNotification, PreviewServer } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { setNav, useNav } from '../nav/store.ts'
import { addWindowKeyHandler, onWindowKeyDown } from '../nav/keys.ts'
import { webHost } from '../native/webview.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { copyText } from '../transcript/store.ts'
import { Floating } from '../live/Floating.tsx'
import { Action, DockEmpty, ErrorLine, Section } from '../dock/parts.tsx'
import { closePreview, floatingPreview, launchPreview, navigatePreview, openPreview, previewState, setPreview, showPreview, subscribePreviews, usePreview } from './store.ts'
import { PreviewSlot, PreviewSurface, previewCommand } from './Surface.tsx'
import { previewDockSize } from './Surface.tsx'
import { useElementBounds } from '../native/layout-hooks.ts'
import { clampPlayerSize, defaultPlayerSize, type PlayerSize } from '../../../../packages/kybern-client/src/previewMiniPlayer.ts'
import { dockGeometry, useDock } from '../dock/store.ts'
import { useSidebarWidth, useWindowWidth } from '../shell/layout.ts'
import { PreviewResizeCapture } from './resize.tsx'
import { MiniResize, type MiniCorner } from './MiniResize.tsx'
import { MiniChrome } from './MiniChrome.tsx'
import { load, save } from '../shell/persist.ts'

export function PreviewPane({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId)
  const { renderer } = useGpuix()
  const input = useRef<PublicInstance | null>(null)
  const entry = s.entries[s.index]
  const [address, setAddress] = useState(entry?.address ?? '')
  const [servers, setServers] = useState<PreviewServer[]>([])
  const [searching, setSearching] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const environment = activeEnvironment()
  const sorted = servers.slice().sort((a, b) => Number(!!b.in_project) - Number(!!a.in_project) || a.port - b.port)
  const shown = showAll ? sorted : sorted.slice(0, 12)
  useEffect(() => setAddress(entry?.address ?? ''), [entry])
  useEffect(() => { if (s.focusAddress && input.current) renderer?.focusElement?.(input.current.id) }, [renderer, s.focusAddress])
  useEffect(() => addWindowKeyHandler(e => { if (e.modifiers?.cmd && !e.modifiers.alt && e.key === 'l') { if (input.current) renderer?.focusElement?.(input.current.id); return true } }), [renderer])
  const discover = async () => { setSearching(true); try { const result = await getClient()!.call('previews.servers.list', { thread_id: threadId }); setServers(result.servers); setPreview(threadId, { error: null }) } catch (e) { setPreview(threadId, { error: String(e) }) } finally { setSearching(false) } }
  useEffect(() => { void discover() }, [threadId])
  return <div testId="dock-preview" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', height: 36, gap: 4, paddingLeft: 6, paddingRight: 6, borderBottomWidth: 0.6, borderColor: t.border }}>
      <IconButton icon={N.arrowLeft} size={28} label="Back" onClick={() => s.bridge?.back ? previewCommand(threadId, 'back') : navigatePreview(threadId, -1)} /><IconButton icon={N.arrowRight} size={28} label="Forward" onClick={() => s.bridge?.forward ? previewCommand(threadId, 'forward') : navigatePreview(threadId, 1)} /><IconButton icon={N.refresh} size={28} label="Reload" onClick={() => { if (entry) void openPreview(threadId, entry.address, false, false, true) }} />
      <input ref={input} testId="preview-address" autoFocus={!entry} aria-label="Address" placeholder="Enter a URL or file path" value={address} onChange={e => setAddress(e.value ?? '')} onSubmit={() => { if (!s.busy) void openPreview(threadId, address) }} onKeyDown={e => { if (e.key === 'escape') setAddress(entry?.address ?? '') }} style={{ flexGrow: 1, minWidth: 0, height: 28, fontSize: 12, paddingLeft: 8, color: t.text, backgroundColor: t.buttonSecondary, borderRadius: 8 }} />
      <Menu align="end" testId="preview-more" trigger={() => <IconButton icon={N.ellipsis} label="More" size={28} />}><MenuItem id="device" testId="preview-device" label={s.device ? 'Hide device toolbar' : 'Show device toolbar'} onSelect={() => setPreview(threadId, { device: !s.device })} /><MenuItem id="float" testId="preview-float" label={s.floating ? 'Return to panel' : 'Float over chat'} disabled={!entry} onSelect={() => setPreview(threadId, { floating: !s.floating })} /><MenuItem id="copy" label="Copy address" disabled={!entry} onSelect={() => { if (entry) copyText(entry.address) }} /><MenuItem id="browser" label="Open in browser" disabled={!entry} onSelect={() => { if (entry) launchPreview(threadId) }} /><MenuItem id="close" testId="preview-close" label="Close page" disabled={!entry} onSelect={() => closePreview(threadId)} /></Menu>
    </div>
    {s.device && <DeviceToolbar threadId={threadId} />}
    <ErrorLine error={s.error} retry={() => void openPreview(threadId, address)} />
    {s.permission ? <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20 }}><Label color={t.text} size={13}>Allow this folder?</Label><Label color={t.textSecondary} size={12} lineHeight={20}>{s.permission.folder}</Label><Action disabled={!s.permission.grantable} onClick={() => void openPreview(threadId, s.permission!.address, true)}>Allow folder</Action><Action onClick={() => setPreview(threadId, { permission: undefined })}>Cancel</Action></div>
    : s.busy ? <DockEmpty icon={N.globe} title="Opening preview…" />
    : entry ? s.floating ? <><DockEmpty icon={N.globe} title="Floating over the chat" /><Action onClick={() => setPreview(threadId, { floating: false })}>Return to panel</Action></> : entry.kind === 'external' ? <><DockEmpty icon={N.globe} title="Open in browser" body="This address opens in your browser." /><Action testId="preview-open-browser" onClick={() => launchPreview(threadId)}>Open in browser</Action></> : <PreviewSlot threadId={threadId} kind="dock" />
    : sorted.length ? <virtual-list style={{ flexGrow: 1, minHeight: 0, width: '100%' }}><div style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 16, paddingBottom: 16 }}>
      <DockSection label={environment.local ? 'Local servers' : `Servers on ${environment.name}`} count={servers.length} />
      <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 12, marginRight: 12, padding: 4, borderRadius: 10, backgroundColor: t.buttonSecondary }}>
        {shown.map(server => <div key={server.url} testId={`preview-server-${server.port}`} role="button" tabIndex={0} onClick={() => void openPreview(threadId, server.url)} onKeyDown={e => { if (e.key === 'enter') void openPreview(threadId, server.url) }} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, paddingLeft: 10, paddingRight: 10, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 5, backgroundColor: t.buttonSecondaryHover, position: 'relative', flexShrink: 0 }}><Icon source={N.globe} size={13} color={t.textSecondary} /><div style={{ position: 'absolute', right: -2, bottom: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: t.green }} /></div>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={muted(t, 0.9)} size={14} lineHeight={21} truncate>{server.title && server.title.length <= 48 ? server.title : server.process_name ?? server.host}</Label><Label color={muted(t, 0.7)} size={13} lineHeight={19.5} truncate>{[server.process_name, server.cwd?.split('/').filter(Boolean).slice(-3).join('/')].filter(Boolean).join(' · ')}</Label></div>
          <Label color={t.textSecondary} size={13}>{new URL(server.url).host}</Label>
        </div>)}
      </div>
      {!showAll && sorted.length > 12 && <Action onClick={() => setShowAll(true)}>{`Show ${sorted.length - 12} more`}</Action>}
      <Label color={muted(t, 0.6)} size={13} lineHeight={16} style={{ paddingLeft: 14, paddingTop: 2, paddingBottom: 8 }}>{environment.local ? 'Servers in this project come first. Updated when this panel opens.' : `Kybern forwards these through the connection to ${environment.name}.`}</Label>
    </div></virtual-list> : <DockEmpty icon={N.globe} title={searching ? 'Looking for local servers…' : 'No local servers running'} body="Start a dev server or enter a file path above. Servers appear here while they run." />}

  </div>
}
function DeviceToolbar({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId)
  const [width, setWidth] = useState(String(s.width)), [height, setHeight] = useState(String(s.height))
  useEffect(() => { setWidth(String(s.width)); setHeight(String(s.height)) }, [s.width, s.height])
  const commit = () => { const w = parseViewportField(width), h = parseViewportField(height); if (w !== null && h !== null && isViewportSizeValid(w, h)) setPreview(threadId, { width: w, height: h, preset: null, error: null }); else { setWidth(String(s.width)); setHeight(String(s.height)); setPreview(threadId, { error: 'Use dimensions from 240–3840.' }) } }
  return <div testId="preview-device-toolbar" style={{ display: 'flex', height: 32, alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 8 }}><Menu testId="preview-device-preset" trigger={() => <Action onClick={() => {}}>{VIEWPORT_PRESETS.find(p => p.id === s.preset)?.label ?? 'Responsive'}</Action>}><MenuItem id="responsive" label="Responsive" onSelect={() => setPreview(threadId, { preset: null })} />{VIEWPORT_PRESETS.map(p => <MenuItem key={p.id} id={p.id} label={`${p.label} · ${p.w} × ${p.h}`} onSelect={() => setPreview(threadId, { width: p.w, height: p.h, preset: p.id })} />)}</Menu><input testId="preview-width" aria-label="Width" value={width} onChange={e => setWidth(e.value ?? '')} onSubmit={commit} onBlur={commit} style={{ width: 48, height: 24, fontSize: 11, color: t.text, backgroundColor: t.buttonSecondary }} /><Label color={t.textSecondary} size={11}>×</Label><input testId="preview-height" aria-label="Height" value={height} onChange={e => setHeight(e.value ?? '')} onSubmit={commit} onBlur={commit} style={{ width: 48, height: 24, fontSize: 11, color: t.text, backgroundColor: t.buttonSecondary }} /><Action testId="preview-rotate" onClick={() => setPreview(threadId, { width: s.height, height: s.width })}>Rotate</Action><IconButton icon={N.x} size={24} label="Hide device toolbar" onClick={() => setPreview(threadId, { device: false })} /></div>
}
/** Agent requests and shortcut live outside the dock; closing it unmounts its UI. */
export function PreviewIntegration({ insetBottom = 0 }: { insetBottom?: number } = {}) {
  const id = useApp(s => s.selectedId), connected = useApp(s => s.status === 'open')
  const page = useNav(s => s.page), settings = useNav(s => s.settingsOpen)
  const floating = useSyncExternalStore(subscribePreviews, floatingPreview)
  const dock = useDock(id), windowWidth = useWindowWidth(), sidebarWidth = useSidebarWidth(), sidebarOpen = useApp(s => s.sidebarOpen)
  const insetEnd = dock.open && page === 'home' && !settings ? dockGeometry(windowWidth, sidebarOpen ? sidebarWidth : 0, dock.width).width : 0
  useEffect(() => webHost.subscribe(event => { if (event.type === 'shortcut') onWindowKeyDown({ elementId: 0, eventType: 'keyDown', key: event.key, modifiers: event.modifiers }) }), [])
  useEffect(() => addWindowKeyHandler(e => {
    if (!id || page !== 'home' || settings || !e.modifiers?.cmd) return
    if (e.key === 'l' && !e.modifiers.alt) { showPreview(id); setPreview(id, { focusAddress: Date.now() }); return true }
    if (e.key === 'r' && !e.modifiers.alt) { previewCommand(id, 'reload'); return true }
  }), [id, page, settings])
  useEffect(() => {
    if (!connected) return
    return getClient()!.onNotification('previews.open_requested', payload => { const request = payload as PreviewOpenRequestedNotification; showPreview(request.thread_id); void openPreview(request.thread_id, request.target) })
  }, [connected])
  useEffect(() => addWindowKeyHandler(e => { if (id && page === 'home' && !settings && e.modifiers?.cmd && e.modifiers.alt && e.key === 'p') { setNav({ keyboardNav: true }); const s = previewState(id); if (s.entries.length) { setPreview(id, { floating: !s.floating }); if (s.floating) showPreview(id) } else showPreview(id); return true } }), [id, page, settings])
  const ids = [...new Set([id, floating].filter((value): value is string => !!value))].sort()
  return <>{ids.map(threadId => <PreviewSurface key={threadId} threadId={threadId} />)}{floating && page === 'home' && !settings ? <MiniPlayer key={floating} insetBottom={insetBottom} insetEnd={insetEnd} threadId={floating} /> : null}<PreviewResizeCapture /></>
}
function MiniPlayer({ threadId, insetBottom, insetEnd }: { threadId: string; insetBottom: number; insetEnd: number }) {
  const t = useTheme(), s = usePreview(threadId), entry = s.entries[s.index]
  const bounds = useElementBounds('preview-mini-bounds')?.rect
  const [corner, setCorner] = useState<MiniCorner>(() => { const saved = load<string>('kybern.preview.corner', 'bottom-end'); return ['top-start','top-end','bottom-start','bottom-end'].includes(saved) ? saved as MiniCorner : 'bottom-end' })
  const [savedSize, setSize] = useState<PlayerSize | null>(() => { const saved = load<PlayerSize | null>('kybern.preview.size', null); return saved && Number.isFinite(saved.w) && Number.isFinite(saved.h) ? saved : null })
  const available = bounds ? { w: Math.max(240, bounds.width - insetEnd), h: bounds.height } : undefined
  const size = savedSize ? clampPlayerSize(savedSize, available) : defaultPlayerSize(previewDockSize(threadId), available)
  if (!s.floating || !entry) return null
  return <Floating insetBottom={insetBottom} insetEnd={insetEnd} defaultCorner="bottom-end" onCornerChange={setCorner} storageKey="kybern.preview.corner" testId="preview-mini" width={size.w} height={size.h} overlayDrag><div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}><PreviewSlot threadId={threadId} kind="mini" /><MiniChrome title={s.pageTitle || entry.title}><IconButton icon={N.panelRight} size={24} testId="preview-mini-return" label="Return to panel" onClick={() => { setPreview(threadId, { floating: false }); showPreview(threadId) }} /><IconButton icon={N.x} size={24} testId="preview-mini-close" label="Close preview" onClick={() => { setPreview(threadId, { floating: false }) }} /></MiniChrome><MiniResize corner={corner} size={size} bounds={available} onResize={next => { setSize(next); save('kybern.preview.size', next) }} /></div></Floating>
}
