// Images stored outside the event log (#298) arrive as `kybern://asset/<hash>`. They are fetched from the machine that
// owns the thread (`threadClient`), with that machine's credentials, and shown as a data URL. Virtual rows remount, so a
// bounded cache keeps recent ones; a stored file never changes, so a cached one never goes stale.
import { useEffect, useState } from 'react'
import { threadClient, usePaneAccess } from '../state.ts'
import { useEnvironment } from '../shell/environment.ts'

const LIMIT_BYTES = 32 * 1024 * 1024
const LIMIT_ENTRIES = 48
const cache = new Map<string, { source: string; bytes: number }>()
let bytes = 0

function remember(key: string, source: string, size: number) {
  if (size > LIMIT_BYTES / 2) return
  const prior = cache.get(key)
  if (prior) { bytes -= prior.bytes; cache.delete(key) }
  while (cache.size && (cache.size >= LIMIT_ENTRIES || bytes + size > LIMIT_BYTES)) {
    const oldest = cache.keys().next().value!
    bytes -= cache.get(oldest)!.bytes
    cache.delete(oldest)
  }
  cache.set(key, { source, bytes: size })
  bytes += size
}

/** `path` is the daemon path (`/assets/<id>`). */
export function useAssetSource(path: string): { source?: string; failed?: boolean } {
  const environment = useEnvironment()
  const pane = usePaneAccess()
  const { selectedId, selectedMachineId } = pane.get()
  const key = `${environment.revision}:${selectedMachineId ?? ''}:${path}`
  const [image, setImage] = useState<{ key: string; source?: string; failed?: boolean }>(() => ({ key, source: cache.get(key)?.source }))
  useEffect(() => {
    const cached = cache.get(key)
    if (cached) { setImage({ key, source: cached.source }); return }
    const owner = threadClient(selectedId, selectedMachineId), abort = new AbortController()
    setImage({ key })
    if (!owner) return
    void (async () => {
      const response = await owner.fetch(path, { signal: abort.signal })
      if (!response.ok) throw Error('Image unavailable')
      const media = response.headers.get('content-type')?.split(';')[0]
      if (!media?.startsWith('image/')) throw Error('Image unavailable')
      const data = await response.arrayBuffer()
      if (abort.signal.aborted) return
      const source = `data:${media};base64,${Buffer.from(data).toString('base64')}`
      remember(key, source, data.byteLength)
      setImage({ key, source })
    })().catch(() => { if (!abort.signal.aborted) setImage({ key, failed: true }) })
    return () => abort.abort()
  }, [key])
  return image.key === key ? image : {}
}
