import { useEffect, useState } from 'react'
import { artifactView, publishArtifactPrompt, type ArtifactView } from '../../../../packages/kybern-client/src/artifacts.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import type { ArtifactTool, FilesReadResult, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { openUrl } from '../pulls/PrStates.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Action, ErrorLine, Section } from './parts.tsx'
import { FileCode } from './Explorer.tsx'

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
    return artifact ? [{ key: String(item.seq), height: 138, render: () => <div testId={`artifact-${item.seq}`} style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 6, padding: 12, borderRadius: 12, backgroundColor: t.buttonSecondary, borderWidth: 0.6, borderColor: t.border }}>
      <Label color={t.text} size={13} weight={500} truncate>{artifact.title}</Label>
      <Label color={t.textSecondary} size={11}>{artifact.status === 'published' ? 'Published on Claude' : artifact.status === 'publishing' ? 'Waiting for Claude to publish' : artifact.status === 'failed' ? 'Publication failed' : 'Check Claude’s publication result'}</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{artifact.path && <Action onClick={() => setSelected(artifact)}>Preview</Action>}{artifact.url && <Action onClick={() => openUrl(artifact.url!)}>Open in Claude</Action>}{artifact.path && artifact.status !== 'publishing' && <Action disabled={busy} onClick={() => void publish(artifact)}>{artifact.url ? 'Ask to update publication' : 'Check publishing options'}</Action>}</div>
    </div> }] : []
  })
  if (selected) return <ArtifactPreview thread={thread} artifact={selected} close={() => setSelected(null)} />
  return <div testId="dock-artifacts" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <Section label="Artifacts"><Action disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh</Action></Section>
    <ErrorLine error={error} />{notice && <Section label={notice} />}
    {thread.provider.kind === 'claude-code' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12 }}><input testId="artifact-path" aria-label="Artifact file path" placeholder="artifacts/dashboard.html" value={path} onChange={e => setPath(e.value ?? '')} style={{ height: 30, fontSize: 12, color: t.text, backgroundColor: t.buttonSecondary, borderRadius: 6, paddingLeft: 8 }} /><div style={{ display: 'flex', gap: 6 }}><Action testId="artifact-preview" disabled={!path.trim()} onClick={() => setSelected({ id: 'local', seq: 0, title: path.split('/').pop() || 'Artifact', path: path.trim(), url: null, status: 'completed' })}>Preview file</Action><Action disabled={!path.trim() || busy} onClick={() => void publish({ path: path.trim(), url: null })}>Check publishing options</Action></div></div>}
    {entries.length ? <TaskWindow entries={entries} card testId="artifacts-list" /> : <Label color={t.textSecondary} size={12} lineHeight={20} style={{ padding: 12 }}>{busy ? 'Loading artifacts…' : thread.provider.kind === 'claude-code' ? 'Preview a local file or check whether Claude has a publishing tool available.' : 'Local previews stay on your computer. Hosting requires a publishing tool available to the agent.'}</Label>}
    {before !== null && <Action disabled={busy} onClick={() => void older()}>Load earlier artifacts</Action>}
  </div>
}
function ArtifactPreview({ thread, artifact, close }: { thread: Thread; artifact: ArtifactView; close: () => void }) {
  const t = useTheme()
  const [file, setFile] = useState<FilesReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState(false)
  const [revision, reload] = useState(0)
  useEffect(() => {
    let alive = true
    void getClient()!.call('threads.artifacts.read', { thread_id: thread.id, path: artifact.path! }).then(result => { if (alive) { if (result.binary || result.truncated) setError('This file is binary or larger than 1 MB. Open the hosted artifact instead.'); else { setFile(result); setError(null) } } }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [thread.id, artifact.path, revision])
  const browser = async () => {
    try { const client = getClient()!; const result = await client.call('threads.artifacts.preview', { thread_id: thread.id, path: artifact.path! }); openUrl(`${httpBase(client.endpoint.url)}/artifact-preview/${encodeURIComponent(result.ticket)}`) }
    catch (e) { setError(String(e)) }
  }
  const markdown = /\.(md|markdown)$/i.test(artifact.path ?? '') && (file?.content.length ?? 0) < 96 * 1024
  return <div testId="artifact-file-preview" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}><Section label={artifact.title}><Action onClick={close}>Back</Action><Action onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</Action></Section><ErrorLine error={error} retry={() => reload(n => n + 1)} />{file && (markdown && !source ? <div style={{ overflow: 'scroll', flexGrow: 1, padding: 12 }}><markdown source={file.content} theme={cachedMarkdownTheme(t)} /></div> : source || markdown ? <FileCode content={file.content} path={artifact.path!} /> : <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 20 }}><Label color={t.textSecondary} size={12} lineHeight={20}>Open this local preview in your browser.</Label><Action testId="artifact-open-browser" onClick={() => void browser()}>Open in browser</Action></div>)}</div>
}
