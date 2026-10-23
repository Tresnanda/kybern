import { useEffect, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds, type ElementBoundsEvent } from '../native/layout.ts'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { useWebLayer } from '../native/web-occlusion.ts'
import { webHost } from '../native/webview.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { visualTheme } from '../preview/theme.ts'
import { visualLink } from '../../../../packages/kybern-client/src/visuals.ts'
import { artifactView, publishArtifactPrompt, type ArtifactView } from '../../../../packages/kybern-client/src/artifacts.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import type { ArtifactTool, FilesReadResult, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { launchBrowser } from '../preview/browser.ts'
import { openUrl } from '../pulls/PrStates.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { Label, useTheme } from '../ui.tsx'
import { ErrorLine, Section } from './parts.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { openTab } from '../tabs/open.ts'

/** `--font-mono-family` (kit.css): JetBrains Mono first. */
const FONT_CODE = 'JetBrains Mono'

export function ArtifactsPane({ thread }: { thread: Thread }) {
  const t = useTheme()
  const [items, setItems] = useState<ArtifactTool[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState<ArtifactView | null>(null)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let alive = true
    setBusy(true)
    void getClient()!.call('threads.artifacts.list', { thread_id: thread.id }).then(result => { if (alive) { setItems(result.artifacts); setBefore(result.next_before_seq); setError(null) } }, e => { if (alive) setError(String(e)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [thread.id, thread.status, refresh])
  const older = async () => {
    if (before === null || busy) return
    setBusy(true)
    try { const result = await getClient()!.call('threads.artifacts.list', { thread_id: thread.id, before_seq: before }); setItems(old => [...old, ...result.artifacts.filter(a => !old.some(b => a.seq === b.seq))]); setBefore(result.next_before_seq) }
    catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const publish = async (artifact: Pick<ArtifactView, 'path' | 'url'>) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const message = { parts: [{ type: 'text' as const, text: publishArtifactPrompt(artifact) }] }
      const client = getClient()!
      if (thread.status === 'running' || thread.status === 'awaiting-approval') {
        await client.call('queue.add', { id: crypto.randomUUID(), thread_id: thread.id, message })
        setNotice('Publishing capability check queued.')
      } else { await client.call('threads.send', { thread_id: thread.id, message }); setNotice('Claude is checking which publishing tools are available.') }
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const entries: TaskWindowEntry[] = items.flatMap(item => {
    const artifact = artifactView(item)
    return artifact ? [{ key: String(item.seq), height: 138, intrinsic: true, render: () => <div testId={`artifact-${item.seq}`} style={{ display: 'flex', flexDirection: 'column', marginLeft: 12, marginRight: 12, marginBottom: 12, padding: 12, borderRadius: 14, backgroundColor: t.buttonSecondary, borderWidth: 1, borderColor: t.border }}>
      <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{artifact.title}</Label>
      <Label color={t.textSecondary} size={12} lineHeight={16} style={{ marginTop: 4 }}>{artifact.status === 'published' ? 'Published on Claude' : artifact.status === 'publishing' ? 'Waiting for Claude to publish' : artifact.status === 'failed' ? 'Publication failed' : 'Check Claude’s publication result'}</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{artifact.path && <Button size="sm" onClick={() => openTab(thread.id, { kind: 'artifact', path: artifact.path!, title: artifact.title, ...(artifact.url ? { url: artifact.url } : {}) })}>Preview</Button>}{artifact.url && <Button size="sm" onClick={() => openUrl(artifact.url!)}>Open in Claude</Button>}{artifact.url && <Button size="sm" variant="ghost" onClick={() => openUrl(artifact.url!)}>Share and versions</Button>}{artifact.path && artifact.status !== 'publishing' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void publish(artifact)}>{busy ? 'Sending…' : artifact.url ? 'Ask to update publication' : 'Check publishing options'}</Button>}</div>
    </div> }] : []
  })
  return <div testId="dock-artifacts" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 12, marginBottom: 12 }}><Label color={t.text} size={14} lineHeight={20} weight={500} style={{ flexGrow: 1 }}>Artifacts</Label><Button size="sm" variant="ghost" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh</Button></div>
    <ErrorLine error={error} />{notice && <Section label={notice} />}
    {thread.provider.kind === 'claude-code' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 12, paddingRight: 12, paddingBottom: 16 }}><TextField testId="artifact-path" label="Artifact file path" placeholder="artifacts/dashboard.html" value={path} onChange={setPath} width="100%" /><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><Button size="sm" testId="artifact-preview" disabled={!path.trim()} onClick={() => setSelected({ id: 'local', seq: 0, title: path.split('/').pop() || 'Artifact', path: path.trim(), url: null, status: 'completed' })}>Preview file</Button><Button size="sm" disabled={!path.trim() || busy} onClick={() => void publish({ path: path.trim(), url: null })}>Check publishing options</Button></div></div>}
    {entries.length ? <TaskWindow entries={entries} card testId="artifacts-list" /> : <Label color={t.textSecondary} size={12} lineHeight={19.5} style={{ paddingLeft: 12, paddingRight: 12, whiteSpace: 'normal' }}>{busy ? 'Loading artifacts…' : thread.provider.kind === 'claude-code' ? 'Preview a local file or check whether Claude has a publishing tool available.' : 'Local previews stay on your computer. Hosting requires a publishing tool available to the agent.'}</Label>}
    {before !== null && <div style={{ display: 'flex', paddingLeft: 12, paddingTop: 12 }}><Button size="sm" variant="ghost" disabled={busy} onClick={() => void older()}>Load earlier artifacts</Button></div>}
    {selected && <ArtifactPreview key={`${thread.id}:${selected.path}`} thread={thread} artifact={selected} close={() => setSelected(null)} />}
  </div>
}
/** An artifact's file and, for HTML, its local preview ticket URL. */
function useArtifactFile(threadId: string, path: string) {
  const [file, setFile] = useState<FilesReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const markdown = /\.(md|markdown)$/i.test(path)
  useEffect(() => {
    let alive = true
    setFile(null); setError(null); setUrl(null)
    const client = getClient()!
    void client.call('threads.artifacts.read', { thread_id: threadId, path: path }).then(async result => {
      if (result.binary || result.truncated) throw new Error('This file is binary or larger than 1 MB. Open the hosted artifact instead.')
      if (!alive) return
      setFile(result)
      if (!markdown) { const preview = await client.call('threads.artifacts.preview', { thread_id: threadId, path: path }); if (alive) setUrl(`${httpBase(client.endpoint.url)}/artifact-preview/${encodeURIComponent(preview.ticket)}`) }
    }).catch(e => { if (alive) setError(String(e).replace(/^Error: /, '')) })
    return () => { alive = false }
  }, [threadId, path])
  return { file, error, setError, url, markdown }
}

/** An artifact opened as a tab (ADE-54): Source and Preview over the whole tab, the page in its own sandboxed document. */
export function ArtifactTab({ threadId, path, url: hosted }: { threadId: string; path: string; url?: string }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const { file, error, setError, url, markdown } = useArtifactFile(threadId, path)
  const [source, setSource] = useState(false)
  const [host, setHost] = useState<PublicInstance | null>(null)
  const [height, setHeight] = useState(400)
  useEffect(() => host ? observeElementBounds(renderer, host.id, e => { if (e.rect) setHeight(h => Math.abs(h - e.rect!.height) < 0.5 ? h : e.rect!.height) }) : undefined, [renderer, host])
  return <div testId="artifact-tab" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, gap: 12, padding: 16 }}>
    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
      <Button size="sm" testId="artifact-source" onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</Button>
      {hosted && <Button size="sm" variant="ghost" onClick={() => openUrl(hosted)}>Open in Claude</Button>}
    </div>
    <div ref={setHost} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
      {error ? <Label color={t.red} size={14}>{error}</Label>
        : !file ? <Label color={t.textSecondary} size={14}>Loading preview…</Label>
        : <>
          {source && <div testId="artifact-source-text" style={{ height, overflow: 'scroll' }}><Label color={t.text} size={12} lineHeight={16} font={FONT_CODE} style={{ whiteSpace: 'normal', width: '100%' }}>{file.content}</Label></div>}
          {markdown ? !source && <div style={{ height, overflow: 'scroll' }}><markdown style={{ userSelect: 'text' }} source={file.content} theme={cachedMarkdownTheme(t)} /></div>
            : url ? <ArtifactFrame id={`artifact-tab:${threadId}:${path}`} url={url} height={height} hidden={source} onFailed={setError} /> : !source && <Label color={t.textSecondary} size={14}>Loading preview…</Label>}
        </>}
    </div>
  </div>
}

/** The desktop's sandboxed `<iframe sandbox="allow-scripts">`: one native web document in a slot, shared with inline visuals. */
function ArtifactFrame({ id, url, height, hidden, onFailed }: { id: string; url: string; height: number; hidden: boolean; onFailed: (message: string) => void }) {
  const renderer = useGpuixRequired(), ref = useRef<PublicInstance | null>(null), layer = useWebLayer(), t = useTheme()
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden
  const theme = useRef(visualTheme(t)); theme.current = visualTheme(t)
  const place = useRef<() => void>(() => {}), ready = useRef(false)
  useEffect(() => {
    if (!ref.current) return
    let latest: ElementBoundsEvent | undefined, generation = 0
    place.current = () => {
      const rect = latest?.rect, clip = latest?.clippedRect
      if (!rect || !clip || !ready.current || hiddenRef.current) { webHost.hide(id); return }
      webHost.place(id, rect, clip, { width: rect.width, height: rect.height, scale: 1, left: 0, top: 0 }, true, layer)
    }
    const stop = webHost.subscribe(event => {
      if (event.id !== id || (event.generation !== undefined && event.generation !== generation)) return
      if (event.type === 'created' || event.type === 'loaded') { ready.current = true; place.current(); webHost.theme(id, theme.current) }
      if (event.type === 'failed' || event.type === 'terminated') onFailed(event.message ?? 'The page stopped responding.')
      if (event.type === 'message' && event.data?.kind === 'kybern-visual-link') { const link = visualLink(event.data.url); if (link) void launchBrowser(link).catch(error => onFailed(String(error))) }
    })
    const bounds = observeElementBounds(renderer, ref.current.id, next => { latest = next; place.current() })
    try { generation = webHost.create(id, url, 'visual') } catch (error) { onFailed(String(error)) }
    return () => { bounds(); stop(); ready.current = false; webHost.destroy(id) }
  }, [renderer, id, url, layer])
  useEffect(() => { if (ready.current) webHost.theme(id, theme.current) }, [id, t])
  useEffect(() => { place.current() }, [hidden])
  // Source keeps the page loaded under it, like the desktop's `hidden` iframe.
  return <div ref={ref} testId="artifact-frame" style={{ height: hidden ? 0 : height, width: '100%', borderRadius: 8, backgroundColor: '#ffffff', flexShrink: 0 }} />
}

/** Desktop `ArtifactPreview`: a dialog with Source and Preview, the page in a sandboxed frame, Markdown rendered natively. */
function ArtifactPreview({ thread, artifact, close }: { thread: Thread; artifact: ArtifactView; close: () => void }) {
  const t = useTheme(), size = useNativeWindowSize()
  const { file, error, setError, url, markdown } = useArtifactFile(thread.id, artifact.path!)
  const [source, setSource] = useState(false)
  const width = Math.min(1024, Math.max(320, size.width - 64)), height = Math.max(160, Math.min(800, size.height * 0.9) - 170)
  return <Dialog width={width} onClose={close} testId="artifact-file-preview">
    <DialogHeader title={artifact.title} description="Local preview. Open in Claude for live connectors, sharing, and version history." onClose={close} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 16, paddingRight: 16, paddingBottom: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" testId="artifact-source" onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</Button>
        {artifact.url && <Button size="sm" variant="ghost" onClick={() => openUrl(artifact.url!)}>Open in Claude</Button>}
      </div>
      {error ? <Label color={t.red} size={14}>{error}</Label>
        : !file ? <Label color={t.textSecondary} size={14}>Loading preview…</Label>
        : <>
          {/* Desktop `<pre className="text-xs whitespace-pre-wrap">`: the raw file in the mono family, wrapped. */}
          {source && <div testId="artifact-source-text" style={{ height, overflow: 'scroll' }}><Label color={t.text} size={12} lineHeight={16} font={FONT_CODE} style={{ whiteSpace: 'normal', width: '100%' }}>{file.content}</Label></div>}
          {markdown ? !source && <div style={{ height, overflow: 'scroll' }}><markdown style={{ userSelect: 'text' }} source={file.content} theme={cachedMarkdownTheme(t)} /></div>
            : url ? <ArtifactFrame id={`artifact:${thread.id}:${artifact.path}`} url={url} height={height} hidden={source} onFailed={setError} /> : !source && <Label color={t.textSecondary} size={14}>Loading preview…</Label>}
        </>}
    </div>
  </Dialog>
}
