// A person's avatar: GitHub's picture when there is one, otherwise the first letter on a hue taken from the login. The picture is
// fetched once per url into the image cache (`transcript/imageFiles.ts`, as every other image) and painted from that file; until it
// arrives, and if it never does, the letter stays, so a slow or blocked CDN costs nothing visible. A 1 px white edge at 10% keeps a
// picture with a pale background from dissolving into the surface (the design's inset ring).
import { useEffect, useState } from 'react'
import { avatarSource } from './avatarSource.ts'
import { storeImageBytes } from '../transcript/imageFiles.ts'
import { Label, useTheme } from '../ui.tsx'

const files = new Map<string, Promise<string | null>>()
/** The cached file for an avatar url; null when it could not be fetched (never retried this session). */
function avatarFile(url: string): Promise<string | null> {
  let pending = files.get(url)
  if (!pending) {
    pending = fetch(url).then(async response => {
      const media = (response.headers.get('content-type') ?? '').split(';')[0].trim()
      if (!response.ok || !media.startsWith('image/')) return null
      return storeImageBytes(new Uint8Array(await response.arrayBuffer()), media)
    }).catch(() => null)
    files.set(url, pending)
  }
  return pending
}

export function useAvatarFile(url: string | undefined, size: number): string | null {
  const source = url ? avatarSource(url, size) : ''
  const [state, setState] = useState<{ source: string; file: string | null } | null>(null)
  useEffect(() => {
    if (!source) return
    let alive = true
    void avatarFile(source).then(file => { if (alive) setState({ source, file }) })
    return () => { alive = false }
  }, [source])
  return state?.source === source ? state.file : null
}

/** A hue from the login, so the same person keeps the same colour. */
export function avatarHue(login: string): number {
  let h = 0
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 360
  return h
}

export function Avatar({ login, url, size = 16, testId }: { login: string; url?: string; size?: number; testId?: string }) {
  const t = useTheme()
  const file = useAvatarFile(url, size)
  const ring = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
  return (
    <div testId={testId} aria-label={login} style={{ width: size, height: size, flexShrink: 0, borderRadius: size / 2, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: `oklch(0.62 0.12 ${avatarHue(login)})` }}>
      {file
        ? <img src={file} alt="" objectFit="cover" style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: ring, pointerEvents: 'none' }} />
        : <Label color="#ffffff" size={Math.max(8, Math.round(size * 0.5))} lineHeight={size} weight={600} style={{ pointerEvents: 'none' }}>{login.slice(0, 1).toUpperCase()}</Label>}
    </div>
  )
}
