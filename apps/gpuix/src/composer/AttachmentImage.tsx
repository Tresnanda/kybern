import { useEffect, useState } from 'react'
import { threadClient, useApp } from '../state.ts'
import { activeEnvironment, useEnvironment } from '../shell/environment.ts'
import { Label, useTheme } from '../ui.tsx'
import { ResponseImage } from '../transcript/images.tsx'

// Virtual rows may remount. Keep a bounded preview cache, scoped to the connection.
const cache = new Map<string, { source: string; bytes: number }>()
let bytes = 0
/** A just-sent image the composer already holds (a file path or a data URI): the bubble shows it at once instead of
 *  loading it back from the daemon, so the new chat's image flight lands on the picture (`draft/Morph.tsx`). */
export function primeAttachmentImage(assetId: string, source: string) {
  const key = `${activeEnvironment().revision}:${assetId}`
  if (!cache.has(key)) cache.set(key, { source, bytes: 0 })
}
export function AttachmentImage({ assetId, name }: { assetId: string; name: string }) {
  const t = useTheme(), environment = useEnvironment(), threadId = useApp(s => s.selectedId), machineId = useApp(s => s.selectedMachineId)
  const key = `${environment.revision}:${assetId}`
  const [image, setImage] = useState<{ key: string; source?: string; failed?: boolean }>(() => ({ key, source: cache.get(key)?.source }))
  useEffect(() => {
    const cached = cache.get(key)
    if (cached) { setImage({ key, source: cached.source }); return }
    const owner = threadClient(threadId, machineId), abort = new AbortController()
    setImage({ key })
    if (!owner) return
    void (async () => {
      const response = await owner.fetch(`/assets/${encodeURIComponent(assetId)}`, { signal: abort.signal })
      if (!response.ok) throw Error('Image unavailable')
      const media = response.headers.get('content-type')?.split(';')[0]
      if (!media?.startsWith('image/')) throw Error('Image unavailable')
      const data = await response.arrayBuffer()
      if (abort.signal.aborted || threadClient(threadId, machineId) !== owner) return
      const source = `data:${media};base64,${Buffer.from(data).toString('base64')}`
      if (data.byteLength <= 16 * 1024 * 1024) {
        const prior = cache.get(key)
        if (prior) { bytes -= prior.bytes; cache.delete(key) }
        while (cache.size && (cache.size >= 16 || bytes + data.byteLength > 16 * 1024 * 1024)) { const oldest = cache.keys().next().value!; bytes -= cache.get(oldest)!.bytes; cache.delete(oldest) }
        cache.set(key, { source, bytes: data.byteLength }); bytes += data.byteLength
      }
      setImage({ key, source })
    })().catch(() => { if (!abort.signal.aborted) setImage({ key, failed: true }) })
    return () => abort.abort()
  }, [key, assetId])
  return <div testId={`attachment-image-${assetId}`} style={{ width: 64, minHeight: 64 }}>
    {image.key === key && image.source ? <ResponseImage source={image.source} label={name} thumbnail /> : <Label color={t.textSecondary} size={12}>{image.failed ? 'Image unavailable' : 'Loading image…'}</Label>}
  </div>
}
