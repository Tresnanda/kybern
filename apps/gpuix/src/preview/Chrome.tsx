// PreviewChromeRow.tsx: segmented rest address, edit focus, adaptive actions.
import { useEffect, useRef, useState } from 'react'
import { useGpuix, motion, type PublicInstance } from '@gpuix/react'
import { Alert02Icon, LinkSquare02Icon, SmartPhone01Icon, PictureInPictureIcon } from '@hugeicons/core-free-icons'
import { glyph, Icon, ICONS } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem, MenuSeparator } from '../nav/overlay.tsx'
import { IconButton } from '../sidebar/rows.tsx'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { revealTransform, SwapOnChange } from '../motion/kit.tsx'
import { fadeTo } from '../shell/motion.ts'
import { muted } from '../nav/overlay.tsx'
import type { ReactNode } from 'react'
import { nativeCapabilities } from '../native/api.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { observeElementBounds } from '../native/layout.ts'
import { useElementBounds } from '../native/layout-hooks.ts'
import { getState } from '../state.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { copyText } from '../transcript/store.ts'
import { canShowFileInExplorer, showFileInExplorer } from '../dock/explorerSelection.ts'
import { currentAddress } from './address.ts'
import { closePreview, launchPreview, navigatePreview, openPreview, setPreview, setPreviewProxy, usePreview } from './store.ts'
import { previewCommand } from './Surface.tsx'
const deviceIcon = glyph(SmartPhone01Icon), floatIcon = glyph(PictureInPictureIcon), externalIcon = glyph(LinkSquare02Icon), warningIcon = glyph(Alert02Icon)

export function PreviewChrome({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId), entry = s.entries[s.index], environment = activeEnvironment()
  const { renderer } = useGpuix(), input = useRef<PublicInstance | null>(null)
  const [editing, setEditing] = useState(!entry), [draft, setDraft] = useState(''), [focus, setFocus] = useState(0), [hover, setHover] = useState(false)
  const bounds = useElementBounds('preview-chrome')?.rect, narrow = (bounds?.width ?? 480) < 360
  const thread = getState().threads.find(th => th.id === threadId), project = getState().projects.find(p => p.id === thread?.project_id)
  const address = entry ? currentAddress(entry, s.pagePath, { projectRoot: thread?.cwd ?? project?.path, projectName: project?.name }) : null
  const back = !!(entry?.kind === 'file' && s.bridge?.back) || s.index > 0
  const forward = !!(entry?.kind === 'file' && s.bridge?.forward) || s.index < s.entries.length - 1
  const fileRemote = entry?.kind === 'file' && !environment.local
  const start = () => { setDraft(address?.full ?? ''); setEditing(true); setFocus(n => n + 1); setPreview(threadId, { error: null }) }
  const cancel = () => { setEditing(false); setDraft(''); setPreview(threadId, { error: null }) }
  useEffect(() => { setEditing(!entry); setDraft('') }, [entry])
  useEffect(() => { if (s.focusAddress) { start(); setPreview(threadId, { focusAddress: undefined }) } }, [s.focusAddress])
  useEffect(() => {
    if (!editing || !input.current || !renderer) return
    let focused = false
    return observeElementBounds(renderer, input.current.id, event => {
      if (!event.rect || focused || !input.current) return
      focused = true; renderer.focusElement?.(input.current.id)
      nativeCapabilities(renderer).setInputSelection(input.current.id, 0, draft.length, false)
    })
  }, [renderer, editing, focus])
  const submit = async () => {
    if (!draft.trim()) { cancel(); return }
    if (s.busy) return
    const opened = await openPreview(threadId, draft)
    if (opened) { setEditing(false); setDraft('') }
    else if (input.current) renderer?.focusElement?.(input.current.id)
  }
  const go = (direction: -1 | 1) => {
    if (entry?.kind === 'file' && (direction === -1 ? s.bridge?.back : s.bridge?.forward)) previewCommand(threadId, direction === -1 ? 'back' : 'forward')
    else navigatePreview(threadId, direction)
  }
  const explorerPath = address?.full.split(/[?#]/)[0] ?? ''
  const showExplorer = () => {
    if (entry?.target?.kind !== 'file' || !entry.target.in_project || !thread?.project_id) return
    // Handoff is registered by Explorer without changing preview document ownership.
    showFileInExplorer(threadId, thread.project_id, explorerPath)
  }
  const deviceLabel = s.device ? 'Hide device toolbar' : 'Show device toolbar', floatLabel = s.floating ? 'Return to panel' : 'Float over chat'
  return <div testId="preview-chrome" style={{ display: 'flex', alignItems: 'center', height: 36, flexShrink: 0, gap: 4, paddingLeft: 8, paddingRight: 6, position: 'relative', borderBottomWidth: 1, borderColor: t.surfaceDivider }}>
    <div role="group" aria-label="Navigation" style={{ display: 'flex', gap: 2 }}>
      <Dim on={back}><IconButton testId="preview-back" icon={N.arrowLeft} size={24} label="Back" onClick={() => back && go(-1)} /></Dim>
      {!narrow && <Dim on={forward}><IconButton testId="preview-forward" icon={N.arrowRight} size={24} label="Forward" onClick={() => forward && go(1)} /></Dim>}
      <Dim on={!!entry}><ReloadButton loading={s.loading} onClick={() => entry && previewCommand(threadId, s.loading ? 'stop' : 'reload')} /></Dim>
    </div>
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0, height: 28, gap: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 8, backgroundColor: editing ? t.v('--color-background-elevated-secondary') : undefined, borderWidth: editing ? 1 : 0, borderColor: t.variant === 'dark' ? 'rgba(115, 115, 115, 0.45)' : 'rgba(163, 163, 163, 0.45)', hover: { backgroundColor: t.buttonSecondary } }}>
      <Icon source={s.load.phase === 'blocked' ? ICONS.shield : s.load.phase === 'waiting' || s.load.phase === 'error' ? warningIcon : entry?.kind === 'file' ? ICONS.file : N.globe} size={14} color={t.textSecondary} />
      {!editing && entry?.kind === 'server' && !environment.local && <Label color={t.textSecondary} size={10}>{environment.name}</Label>}
      {editing ? <input ref={input} testId="preview-address" aria-label="Address" value={draft} placeholder="Enter a URL or file path" onChange={e => setDraft(e.value ?? '')} onSubmit={() => void submit()} onBlur={() => { if (!s.busy) cancel() }} onKeyDown={e => { if (e.key === 'escape') cancel() }} style={{ flexGrow: 1, minWidth: 0, height: 26, fontSize: 12, fontFamily: 'JetBrains Mono', color: t.text, backgroundColor: 'transparent' }} />
      : <div testId="preview-address-rest" role="button" aria-label="Address" tabIndex={0} onClick={start} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') start() }} style={{ display: 'flex', flexGrow: 1, minWidth: 0, overflow: 'hidden', alignItems: 'center', cursor: 'text' }}>
        {address?.segments.length ? address.segments.map((part, i) => <Label key={i} color={part.emphasis && !s.navigatedAway ? t.text : t.textSecondary} size={12} truncate style={{ flexShrink: part.emphasis ? 0 : 1, pointerEvents: 'none' }}>{part.text}</Label>) : <Label color={t.textSecondary} size={12} truncate>Enter a URL or file path</Label>}
      </div>}
      {/* Shown while the bar is hovered: `t-reveal` (150 ms in with a 4 px slide, 100 ms out), inert while hidden. */}
      {entry && !editing && <div paintTransform={revealTransform(hover)} style={{ ...(hover ? {} : { pointerEvents: 'none' }), ...(PATCHED_NATIVE ? {} : { opacity: hover ? 1 : 0 }) }}><div style={{ opacity: fileRemote ? 0.4 : 1 }}><IconButton press testId="preview-browser" icon={externalIcon} size={24} glyph={13} label={fileRemote ? `This file is on ${environment.name}` : 'Open in browser'} onHover={setHover} onClick={() => !fileRemote && void launchPreview(threadId)} /></div></div>}
    </div>
    {entry && <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {!narrow && <><IconButton testId="preview-device" icon={deviceIcon} size={28} label={deviceLabel} active={s.device} onClick={() => setPreview(threadId, { device: !s.device })} /><IconButton testId="preview-float" icon={floatIcon} size={28} label={floatLabel} active={s.floating} onClick={() => entry.kind !== 'external' && setPreview(threadId, { floating: !s.floating })} /></>}
      <Menu align="end" testId="preview-more" minWidth={224} trigger={() => <IconButton icon={N.ellipsis} label="More" size={28} />}>
        {narrow && <><MenuItem id="device" testId="preview-device" label={deviceLabel} icon={deviceIcon} onSelect={() => setPreview(threadId, { device: !s.device })} /><MenuItem id="float" testId="preview-float" label={floatLabel} icon={floatIcon} disabled={entry.kind === 'external'} onSelect={() => setPreview(threadId, { floating: !s.floating })} /></>}
        <MenuItem id="fresh" testId="preview-fresh" label="Reload without cache" icon={N.refresh} onSelect={() => previewCommand(threadId, 'reload', true)} />
        <MenuItem id="copy" label="Copy address" icon={ICONS.copy} onSelect={() => copyText(address?.full ?? '')} />
        <MenuItem id="browser" label="Open in browser" icon={externalIcon} disabled={fileRemote} onSelect={() => void launchPreview(threadId)} />
        {entry.target?.kind === 'file' && entry.target.in_project && <MenuItem id="explorer" testId="preview-explorer" label="Show file in Explorer" icon={N.folder} disabled={!thread?.project_id || !canShowFileInExplorer(threadId, thread.project_id, explorerPath)} onSelect={showExplorer} />}
        <MenuSeparator />
        {entry.kind === 'server' && environment.local && <MenuItem id="proxy" testId="preview-proxy" checked={!!entry.proxy} label="Preview through Kybern" onSelect={() => setPreviewProxy(threadId, !entry.proxy)} />}
        <MenuItem id="close" testId="preview-close" label="Close page" icon={N.x} onSelect={() => closePreview(threadId)} />
      </Menu>
    </div>}
    {s.loading && <motion.div testId="preview-loading" initial={{ width: (bounds?.width ?? 360) * (REDUCED_MOTION ? 0.9 : 0.04) }} animate={{ width: (bounds?.width ?? 360) * 0.9 }} transition={{ duration: REDUCED_MOTION ? 0 : 5.3, ease: [0.1, 0.5, 0.2, 1] }} style={{ position: 'absolute', left: 0, bottom: 0, height: 2, backgroundColor: t.link, borderTopRightRadius: 9999, borderBottomRightRadius: 9999, pointerEvents: 'none' }} />}
  </div>
}

/** A nav button that is unavailable: it eases to 35 % (`transition-opacity duration-150`) instead of switching. */
export function Dim({ on, children }: { on: boolean; children: ReactNode }) {
  const dim = fadeTo(on ? 1 : 0.35)
  return <div paintTransform={dim.paintTransform} style={dim.style}>{children}</div>
}

/** Reload while idle, Stop while a page loads: the glyph swaps like `t-icon-swap` (the old one shrinks and blurs out, the new one grows in). */
export function ReloadButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const label = loading ? 'Stop loading' : 'Reload'
  return (
    <div testId="preview-reload" role="button" aria-label={label} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, flexShrink: 0, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
      <SwapOnChange kind="icon" active={loading ? 'stop' : 'reload'} style={{ width: 14, height: 14 }}>
        <Icon source={loading ? N.x : N.refresh} size={14} color={hover ? ink(t, 0.82) : muted(t, 0.6)} />
      </SwapOnChange>
    </div>
  )
}
