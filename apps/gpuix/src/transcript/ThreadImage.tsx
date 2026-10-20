// A Markdown image in an agent reply (`![Caption](.screenshots/shot.png)`). Native Markdown paints images as links, so
// image lines are split out (`splitImages`) and drawn here. A local reference loads through the daemon's
// `/threads/{id}/image` route, as written: relative to the thread's own folder (worktree, Coordinator and delegated
// threads included), hidden folders allowed, or an exact outside path the conversation names. It works the same for
// remote environments. A source that cannot load shows a card with the caption, the reason and what to do, never a bare
// link; one written moments before the reply finished is retried once. Fresh images resolve from a blur (`ResponseImage`).
import { spawn } from 'node:child_process'
import path from 'node:path'
import { useEffect, useState } from 'react'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { imageSource } from '../../../desktop/src/lib/responseImages.ts'
import { getClient, useApp } from '../state.ts'
import { onEnvironmentChange, useEnvironment } from '../shell/environment.ts'
import { Label, useTheme } from '../ui.tsx'
import { Rise } from '../motion/kit.tsx'
import { Icon } from '../icons.tsx'
import { T } from './glyphs.ts'
import { Button, muted } from './kit.tsx'
import { ImageLightbox, imageSize, ResponseImage } from './images.tsx'

/** Retried once after this, for an image the agent wrote moments before its reply arrived. */
const RETRY_MS = 1500
const CACHE_BYTES = 48 * 1024 * 1024

type Loaded = { source: string; bytes: number }
type Failure = { status: number; reason: string }
const cache = new Map<string, Loaded>()
let cached = 0
onEnvironmentChange(() => { cache.clear(); cached = 0 })

function remember(key: string, value: Loaded) {
  if (value.bytes > CACHE_BYTES / 4) return
  const prior = cache.get(key)
  if (prior) { cached -= prior.bytes; cache.delete(key) }
  while (cache.size && cached + value.bytes > CACHE_BYTES) { const oldest = cache.keys().next().value!; cached -= cache.get(oldest)!.bytes; cache.delete(oldest) }
  cache.set(key, value); cached += value.bytes
}

/** What the reader is told, by the daemon's answer. */
export function imageFailure(status: number, text: string): Failure {
  if (status === 404) return { status, reason: 'Image not found. Retry once the agent has saved it.' }
  if (status === 403 && /thread folder/.test(text)) return { status, reason: 'Outside the working folder, and this conversation does not name it.' }
  if (status === 403) return { status, reason: 'This folder is protected, so the image is not shown.' }
  if (status === 415) return { status, reason: 'Not a PNG, JPEG, GIF, WebP or AVIF image.' }
  if (status === 413) return { status, reason: 'Larger than 50 MB, so it is not shown.' }
  return { status, reason: 'Unable to load the image. Try again.' }
}

/** The reference as the message wrote it: `<…>` destinations unwrapped, `file://` kept for the daemon to read. */
const reference = (source: string) => source.replace(/^<(.*)>$/, '$1')

async function load(threadId: string, source: string, signal: AbortSignal): Promise<Loaded> {
  const owner = getClient()
  if (!owner) throw imageFailure(0, '')
  const response = await fetch(`${httpBase(owner.endpoint.url)}/threads/${encodeURIComponent(threadId)}/image?path=${encodeURIComponent(reference(source))}`, { headers: { authorization: `Bearer ${owner.endpoint.token}` }, signal })
  if (!response.ok) throw imageFailure(response.status, await response.text().catch(() => ''))
  const media = response.headers.get('content-type')?.split(';')[0] ?? ''
  if (!media.startsWith('image/')) throw imageFailure(415, '')
  const data = await response.arrayBuffer()
  return { source: `data:${media};base64,${Buffer.from(data).toString('base64')}`, bytes: data.byteLength }
}

function useThreadImage(threadId: string | null, source: string) {
  const environment = useEnvironment()
  const key = `${environment.revision}:${threadId}:${source}`
  const [state, setState] = useState<{ key: string; image?: Loaded; failure?: Failure; attempt: number }>(() => ({ key, image: cache.get(key), attempt: 0 }))
  const current = state.key === key ? state : { key, image: cache.get(key), attempt: 0 }
  useEffect(() => {
    if (!threadId) return
    const hit = cache.get(key)
    if (hit) { setState(s => (s.key === key && s.image === hit ? s : { key, image: hit, attempt: 0 })); return }
    const abort = new AbortController(), attempt = current.attempt
    let retry: ReturnType<typeof setTimeout> | undefined
    // `again`: the one automatic retry. It keeps `attempt`, which counts Retry presses only (the effect reloads when it
    // changes, so storing the retry there made a third request).
    const run = (again: boolean) => {
      void load(threadId, source, abort.signal).then(image => {
        if (abort.signal.aborted) return
        remember(key, image)
        setState({ key, image, attempt })
      }, (failure: Failure | Error) => {
        if (abort.signal.aborted) return
        const known = 'reason' in failure ? failure : imageFailure(0, '')
        // Missing, or the connection hiccupped: it may be written moments after the reply. Once.
        if (!again && attempt === 0 && (known.status === 404 || known.status === 0)) { retry = setTimeout(() => run(true), RETRY_MS); return }
        setState({ key, failure: known, attempt })
      })
    }
    run(false)
    return () => { abort.abort(); clearTimeout(retry) }
    // `attempt` changes only through Retry, which reloads.
  }, [key, current.attempt])
  return { ...current, retry: () => setState({ key, attempt: current.attempt + 1 }) }
}

export function ThreadImage({ threadId, source, alt, at }: { threadId: string | null; source: string; alt: string; at?: string }) {
  const target = imageSource(reference(source))
  const label = alt || 'Agent image'
  if (!target) return <ImageCard label={label} reason="This image source cannot be shown." />
  if (target.kind !== 'local') return <ResponseImage source={reference(source)} label={label} at={at} />
  return <LocalThreadImage threadId={threadId} source={source} label={label} at={at} />
}

function LocalThreadImage({ threadId, source, label, at }: { threadId: string | null; source: string; label: string; at?: string }) {
  const image = useThreadImage(threadId, source)
  const cwd = useApp(s => s.threads.find(th => th.id === threadId)?.cwd ?? (s.open.thread?.id === threadId ? s.open.thread?.cwd : undefined))
  const environment = useEnvironment()
  if (image.image) return <ResponseImage source={image.image.source} label={label} at={at} />
  if (!image.failure) return <ImageCard label={label} loading />
  const local = environment.local && cwd
  const file = local ? path.resolve(cwd, decodeURIComponent(reference(source).replace(/^file:\/\/(localhost)?/, ''))) : null
  // Retry helps only when the file may still appear or the connection failed.
  const retryable = image.failure.status === 404 || image.failure.status === 0 || image.failure.status >= 500
  return <ImageCard label={label} reason={image.failure.reason} onRetry={retryable ? image.retry : undefined}
    onReveal={file ? () => { spawn('open', image.failure!.status === 404 ? [path.dirname(file)] : ['-R', file]).on('error', () => {}) } : undefined} />
}

/** The image's slot while it loads, or why it cannot show: a quiet card with its caption (`ResponseImage`'s width). */
function ImageCard({ label, reason, loading = false, onRetry, onReveal }: { label: string; reason?: string; loading?: boolean; onRetry?: () => void; onReveal?: () => void }) {
  const t = useTheme()
  return <Rise kind="row" play={!loading}>
    <div testId={loading ? 'thread-image-loading' : 'thread-image-failed'} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 280, marginTop: 12, marginBottom: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: t.border, backgroundColor: t.buttonSecondary }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Icon source={T.eye} size={14} color={muted(t)} />
        <Label color={t.text} size={13} weight={500} truncate style={{ flexShrink: 1 }}>{label}</Label>
      </div>
      <Label color={muted(t)} size={12} lineHeight={16}>{loading ? 'Loading image…' : reason ?? ''}</Label>
      {(onRetry || onReveal) && <div style={{ display: 'flex', gap: 8 }}>
        {onRetry && <Button variant="subtle" testId="thread-image-retry" onClick={onRetry}>Retry</Button>}
        {onReveal && <Button variant="ghost" testId="thread-image-reveal" onClick={onReveal}>Show in Finder</Button>}
      </div>}
    </div>
  </Rise>
}

/** An image link clicked in a reply: the image, or the card that says why it cannot load, in the image viewer. */
export function ThreadImagePreview({ threadId, source, onClose }: { threadId: string; source: string; onClose: () => void }) {
  const image = useThreadImage(threadId, source)
  const label = decodeURIComponent(reference(source).split('/').pop() ?? 'Image')
  if (image.image) return <ImageLightbox src={image.image.source} label={label} size={imageSize(image.image.source)} onClose={onClose} finalFocus={() => {}} />
  return image.failure ? <ImageLightboxCard label={label} reason={image.failure.reason} onClose={onClose} onRetry={image.retry} /> : null
}

function ImageLightboxCard({ label, reason, onClose, onRetry }: { label: string; reason: string; onClose: () => void; onRetry: () => void }) {
  return <ImageLightbox src="" label={label} size={null} onClose={onClose} finalFocus={() => {}} body={<ImageCard label={label} reason={reason} onRetry={onRetry} />} />
}
