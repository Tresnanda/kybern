import { useEffect, useRef, useState } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { VIEWPORT_PRESETS, isViewportSizeValid, parseViewportField } from '../../../../packages/kybern-client/src/previewViewport.ts'
import type { PreviewOpenRequestedNotification, PreviewServer } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { setNav, useNav } from '../nav/store.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { openUrl } from '../pulls/PrStates.tsx'
import { copyText } from '../transcript/store.ts'
import { Floating } from '../live/Floating.tsx'
import { Action, DockEmpty, ErrorLine, Section } from '../dock/parts.tsx'
import { closePreview, navigatePreview, openPreview, previewState, setPreview, showPreview, usePreview } from './store.ts'

export function PreviewPane({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId)
  const { renderer } = useGpuix()
  const input = useRef<PublicInstance | null>(null)
  const entry = s.entries[s.index]
  const [address, setAddress] = useState(entry?.address ?? '')
  const [servers, setServers] = useState<PreviewServer[]>([])
  const [searching, setSearching] = useState(false)
  useEffect(() => setAddress(entry?.address ?? ''), [entry])
  useEffect(() => addWindowKeyHandler(e => { if (e.modifiers?.cmd && !e.modifiers.alt && e.key === 'l') { if (input.current) renderer?.focusElement?.(input.current.id); return true } }), [renderer])
  const discover = async () => { setSearching(true); try { const result = await getClient()!.call('previews.servers.list', { thread_id: threadId }); setServers(result.servers); setPreview(threadId, { error: null }) } catch (e) { setPreview(threadId, { error: String(e) }) } finally { setSearching(false) } }
  useEffect(() => { void discover() }, [threadId])
  return <div testId="dock-preview" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', height: 36, gap: 4, paddingLeft: 6, paddingRight: 6, borderBottomWidth: 0.6, borderColor: t.border }}>
      <IconButton icon={N.arrowLeft} size={28} label="Back" onClick={() => navigatePreview(threadId, -1)} /><IconButton icon={N.arrowRight} size={28} label="Forward" onClick={() => navigatePreview(threadId, 1)} /><IconButton icon={N.refresh} size={28} label="Reload" onClick={() => { if (entry) void openPreview(threadId, entry.address) }} />
      <input ref={input} testId="preview-address" autoFocus={!entry} aria-label="Address" placeholder="Enter a URL or file path" value={address} onChange={e => setAddress(e.value ?? '')} onSubmit={() => { if (!s.busy) void openPreview(threadId, address) }} onKeyDown={e => { if (e.key === 'escape') setAddress(entry?.address ?? '') }} style={{ flexGrow: 1, minWidth: 0, height: 28, fontSize: 12, paddingLeft: 8, color: t.text, backgroundColor: t.buttonSecondary, borderRadius: 8 }} />
      <Menu align="end" testId="preview-more" trigger={() => <IconButton icon={N.ellipsis} label="More" size={28} />}><MenuItem id="device" testId="preview-device" label={s.device ? 'Hide device toolbar' : 'Show device toolbar'} onSelect={() => setPreview(threadId, { device: !s.device })} /><MenuItem id="float" testId="preview-float" label={s.floating ? 'Return to panel' : 'Float over chat'} disabled={!entry} onSelect={() => setPreview(threadId, { floating: !s.floating })} /><MenuItem id="copy" label="Copy address" disabled={!entry} onSelect={() => { if (entry) copyText(entry.address) }} /><MenuItem id="browser" label="Open in browser" disabled={!entry} onSelect={() => { if (entry) openUrl(entry.url) }} /><MenuItem id="close" label="Close page" disabled={!entry} onSelect={() => closePreview(threadId)} /></Menu>
    </div>
    {s.device && <DeviceToolbar threadId={threadId} />}
    <ErrorLine error={s.error} retry={() => void openPreview(threadId, address)} />
    {s.permission ? <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20 }}><Label color={t.text} size={13}>Allow this folder?</Label><Label color={t.textSecondary} size={12} lineHeight={20}>{s.permission.folder}</Label><Action disabled={!s.permission.grantable} onClick={() => void openPreview(threadId, s.permission!.address, true)}>Allow folder</Action><Action onClick={() => setPreview(threadId, { permission: undefined })}>Cancel</Action></div>
    : s.busy ? <DockEmpty icon={N.globe} title="Opening preview…" />
    : entry ? <><DockEmpty icon={N.globe} title={s.floating ? 'Floating over the chat' : 'Preview opens in your browser'} body={s.floating ? 'The floating card keeps the address and browser controls within reach.' : 'Use your browser to interact with this page.'} /><Action testId="preview-open-browser" onClick={() => openUrl(entry.url)}>Open in browser</Action>{s.floating && <Action onClick={() => setPreview(threadId, { floating: false })}>Return to panel</Action>}</>
    : <><DockEmpty icon={N.globe} title="Preview a page" body="Enter a URL or HTML file path, or choose a running server." /><Section label="Running servers"><Action disabled={searching} onClick={() => void discover()}>Refresh</Action></Section><virtual-list style={{ maxHeight: 200, minHeight: 48 }}>{servers.slice(0, 20).map(server => <Action key={server.url} onClick={() => void openPreview(threadId, server.url)}>{`${server.title || server.framework || server.process_name || 'Server'} · ${server.port}`}</Action>)}</virtual-list></>}
  </div>
}
function DeviceToolbar({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId)
  const [width, setWidth] = useState(String(s.width)), [height, setHeight] = useState(String(s.height))
  useEffect(() => { setWidth(String(s.width)); setHeight(String(s.height)) }, [s.width, s.height])
  const commit = () => { const w = parseViewportField(width), h = parseViewportField(height); if (w !== null && h !== null && isViewportSizeValid(w, h)) setPreview(threadId, { width: w, height: h, preset: null, error: null }); else { setWidth(String(s.width)); setHeight(String(s.height)); setPreview(threadId, { error: 'Use dimensions from 240–3840.' }) } }
  return <><div testId="preview-device-toolbar" style={{ display: 'flex', height: 32, alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 8 }}><Menu testId="preview-device-preset" trigger={() => <Action onClick={() => {}}>{VIEWPORT_PRESETS.find(p => p.id === s.preset)?.label ?? 'Responsive'}</Action>}><MenuItem id="responsive" label="Responsive" onSelect={() => setPreview(threadId, { preset: null })} />{VIEWPORT_PRESETS.map(p => <MenuItem key={p.id} id={p.id} label={`${p.label} · ${p.w} × ${p.h}`} onSelect={() => setPreview(threadId, { width: p.w, height: p.h, preset: p.id })} />)}</Menu><input testId="preview-width" aria-label="Width" value={width} onChange={e => setWidth(e.value ?? '')} onSubmit={commit} onBlur={commit} style={{ width: 48, height: 24, fontSize: 11, color: t.text, backgroundColor: t.buttonSecondary }} /><Label color={t.textSecondary} size={11}>×</Label><input testId="preview-height" aria-label="Height" value={height} onChange={e => setHeight(e.value ?? '')} onSubmit={commit} onBlur={commit} style={{ width: 48, height: 24, fontSize: 11, color: t.text, backgroundColor: t.buttonSecondary }} /><Action testId="preview-rotate" onClick={() => setPreview(threadId, { width: s.height, height: s.width })}>Rotate</Action><IconButton icon={N.x} size={24} label="Hide device toolbar" onClick={() => setPreview(threadId, { device: false })} /></div><Label color={t.textTertiary} size={11} lineHeight={16} style={{ padding: 8 }}>Use these dimensions in your browser’s responsive mode.</Label></>
}
/** Agent requests and shortcut live outside the dock; closing it unmounts its UI. */
export function PreviewIntegration() {
  const id = useApp(s => s.selectedId), connected = useApp(s => s.status === 'open')
  const page = useNav(s => s.page), settings = useNav(s => s.settingsOpen)
  useEffect(() => {
    if (!connected) return
    return getClient()!.onNotification('previews.open_requested', payload => { const request = payload as PreviewOpenRequestedNotification; showPreview(request.thread_id); void openPreview(request.thread_id, request.target) })
  }, [connected])
  useEffect(() => addWindowKeyHandler(e => { if (id && page === 'home' && !settings && e.modifiers?.cmd && e.modifiers.alt && e.key === 'p') { setNav({ keyboardNav: true }); const s = previewState(id); if (s.entries.length) setPreview(id, { floating: !s.floating }); else showPreview(id); return true } }), [id, page, settings])
  return id && page === 'home' && !settings ? <MiniPlayer key={id} threadId={id} /> : null
}
function MiniPlayer({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId), entry = s.entries[s.index]
  if (!s.floating || !entry) return null
  return <Floating storageKey="kybern.preview.corner" testId="preview-mini" width={320} height={158}><Section label={entry.title}><IconButton icon={N.panelRight} size={24} label="Return to panel" onClick={() => { setPreview(threadId, { floating: false }); showPreview(threadId) }} /><IconButton icon={N.x} size={24} label="Close preview" onClick={() => closePreview(threadId)} /></Section><Label color={t.textSecondary} size={12} truncate style={{ padding: 12 }}>{entry.address}</Label><Label color={t.textTertiary} size={11} style={{ paddingLeft: 12 }}>Preview opens in your browser.</Label><Action testId="preview-mini-open" onClick={() => openUrl(entry.url)}>Open in browser</Action></Floating>
}
