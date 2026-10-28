// A person's picture, or their initial on a hue taken from their name. GitHub's avatar is fetched once per URL and
// kept as a `data:` URI (at most 150, about 3 KB each at the 40 px size the daemon asks for), like the space logos.
import { useEffect, useSyncExternalStore } from 'react'
import { onEnvironmentChange } from '../../shell/environment.ts'
import { Label, useTheme } from '../../ui.tsx'

const sources = new Map<string, string>()
const failed = new Set<string>()
const loading = new Set<string>()
const queue: string[] = []
const listeners = new Set<() => void>()
let version = 0
let active = 0
const MAX_SOURCES = 150
const MAX_ACTIVE = 4
const bump = () => { version++; for (const listener of listeners) listener() }

/** Only GitHub's own avatar hosts are fetched; anything else draws the initial. */
export function isAvatarUrl(url: string | undefined): url is string {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'avatars.githubusercontent.com' || u.hostname.endsWith('.githubusercontent.com') || u.hostname === 'github.com')
  } catch { return false }
}

async function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const url = queue.shift()!
    active++
    void (async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const media = response.headers.get('content-type')?.split(';')[0]
        if (!response.ok || !media?.startsWith('image/')) throw Error('Image unavailable')
        const data = await response.arrayBuffer()
        if (data.byteLength > 256 * 1024) throw Error('Image too large')
        if (sources.size >= MAX_SOURCES) sources.delete(sources.keys().next().value!)
        sources.set(url, `data:${media};base64,${Buffer.from(data).toString('base64')}`)
      } catch { failed.add(url) }
      finally { loading.delete(url); active--; bump(); void pump() }
    })()
  }
}

/** The picture as a `data:` URI once loaded; null while loading or after a failure. */
export function useAvatarImage(url: string | undefined): string | null {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => version)
  useEffect(() => {
    if (!isAvatarUrl(url) || sources.has(url) || failed.has(url) || loading.has(url)) return
    loading.add(url); queue.push(url); void pump()
  }, [url])
  return isAvatarUrl(url) ? sources.get(url) ?? null : null
}

onEnvironmentChange(() => { sources.clear(); failed.clear(); loading.clear(); queue.length = 0; bump() }, -50)

const hueOf = (name: string) => { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return h % 360 }

export function Avatar({ login, url, size = 16, testId }: { login: string; url?: string; size?: number; testId?: string }) {
  const t = useTheme()
  const image = useAvatarImage(url)
  const dark = t.variant === 'dark'
  return <div testId={testId} aria-label={login || 'Unknown author'} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: size / 2, flexShrink: 0, overflow: 'hidden', backgroundColor: `oklch(${dark ? 0.62 : 0.66} 0.12 ${hueOf(login)})` }}>
    {image ? <img src={image} alt="" objectFit="cover" style={{ width: size, height: size }} /> : <Label color="#ffffff" size={Math.round(size * 0.52)} lineHeight={size} weight={600}>{(login || '?').slice(0, 1).toUpperCase()}</Label>}
    <div style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.1)' }} />
  </div>
}
