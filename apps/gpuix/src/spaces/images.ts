// Space logo images: the daemon's derived 128 px PNGs (`GET /assets/{id}`), fetched once and
// kept as `data:` URIs by asset id. Derived assets never change, so there is no invalidation;
// at most 50 spaces of ~20 KB each. Cleared when the environment changes.
import { useEffect, useSyncExternalStore } from 'react'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { getClient } from '../state.ts'

const sources = new Map<string, string>()
const failed = new Set<string>()
const loading = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const bump = () => { version++; for (const listener of listeners) listener() }

async function load(assetId: string) {
  const owner = getClient()
  if (!owner || loading.has(assetId)) return
  loading.add(assetId)
  try {
    const response = await fetch(`${httpBase(owner.endpoint.url)}/assets/${encodeURIComponent(assetId)}`, { headers: { authorization: `Bearer ${owner.endpoint.token}` } })
    const media = response.headers.get('content-type')?.split(';')[0]
    if (!response.ok || !media?.startsWith('image/')) throw Error('Image unavailable')
    const data = await response.arrayBuffer()
    if (getClient() !== owner) return
    sources.set(assetId, `data:${media};base64,${Buffer.from(data).toString('base64')}`)
  } catch {
    if (getClient() === owner) failed.add(assetId)
  } finally {
    loading.delete(assetId)
    if (getClient() === owner) bump()
  }
}

/** The logo image as a `data:` URI once it has loaded; null while loading or after a failure (draw initials). */
export function useSpaceImage(assetId: string | null): string | null {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => version)
  useEffect(() => { if (assetId && !sources.has(assetId) && !failed.has(assetId)) void load(assetId) }, [assetId])
  return assetId ? sources.get(assetId) ?? null : null
}

/** Show a picked file at once, before the daemon has derived it (the editor's preview). */
export function previewSource(key: string, dataUri: string) { sources.set(key, dataUri); bump() }

