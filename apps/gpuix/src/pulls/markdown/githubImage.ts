// Loading an image of an issue's or a pull request's Markdown. Images on GitHub's own hosts go through the daemon that owns
// the project (`GET /github/image`): a private repository's uploads need its `gh` sign-in, which never leaves that machine,
// and a remote machine's project loads the same way. Any other https image is fetched here. Either way the bytes become a
// cached file (`storeImageBytes`), so the image's size is known and it paints like a reply's image.
import { useEffect, useState } from 'react'
import { prClient } from '../client.ts'
import { storeImageBytes } from '../../transcript/imageFiles.ts'

/** Where the image is: which issue or pull request of which project. Without it only non-GitHub images load. */
export interface GithubImageContext { projectId: string; number: number; repo?: string }

export type ImageFailure = { status: number; reason: string }
type Loaded = { source: string }

const MAX_BYTES = 50 * 1024 * 1024
const DIRECT_TIMEOUT_MS = 20_000
const CACHE_ENTRIES = 256
const MEDIA = /^image\/(png|jpeg|gif|webp|avif)$/i

/** GitHub's own image hosts, which the daemon fetches (`github_images.rs`, `classify`). */
export function onGithub(source: string): boolean {
  let url: URL
  try { url = new URL(source) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'github.com') return /^\/(?:user-attachments\/assets\/|[^/]+\/[^/]+\/assets\/)/.test(url.pathname)
  return ['private-user-images', 'user-images', 'raw', 'camo', 'avatars', 'objects', 'media'].some(name => host === `${name}.githubusercontent.com`)
}

/** Only https images load; anything else (a relative path in a repository, `data:`, `http:`) shows its caption. */
export const loadable = (source: string) => /^https:\/\/[^\s/]+/i.test(source.trim())

/** What the reader is told, by the answer's status. */
export function imageFailure(status: number): ImageFailure {
  if (status === 0) return { status, reason: "This project's machine is offline. Try again when it's back." }
  if (status === 404 || status === 410) return { status, reason: "GitHub didn't share this image. Open the issue on GitHub to see it." }
  if (status === 401 || status === 403) return { status, reason: 'This device cannot read images on that machine. Pair it again in Settings → Machines.' }
  if (status === 413) return { status, reason: 'Larger than 50 MB, so it is not shown.' }
  if (status === 415) return { status, reason: 'Not a PNG, JPEG, GIF, WebP or AVIF image.' }
  if (status === -1) return { status, reason: 'This image source cannot be shown.' }
  return { status, reason: 'Unable to load the image. Check the connection, then retry.' }
}

/** The image type of `bytes` by their first bytes, like the daemon's `sniff`. */
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  const text = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (b.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && text(4, 8) === 'ftyp' && /^avi[fs]$/.test(text(8, 12))) return 'image/avif'
  return null
}

async function bytesOf(response: Response): Promise<{ media: string; bytes: Uint8Array }> {
  if (!response.ok) throw imageFailure(response.status)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw imageFailure(413)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_BYTES) throw imageFailure(413)
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  const media = sniff(bytes) ?? (MEDIA.test(declared) ? declared : null)
  if (!media) throw imageFailure(415)
  return { media, bytes }
}

/**
 * Whether an image address an issue's author wrote may be fetched from this computer: https on a public name or address.
 * Loopback, private, link-local and `.local` hosts are refused, so an issue cannot make Kybern probe the local network.
 */
export function publicImageUrl(source: string): boolean {
  let url: URL
  try { url = new URL(source) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host.includes('.') && !host.includes(':')) return false
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host)) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168))
  }
  if (host.includes(':')) return !(host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))
  return true
}

/** Any other host, from this computer, like a browser would; each redirect is checked like the first address. */
async function direct(source: string, signal: AbortSignal) {
  const abort = new AbortController()
  const stop = () => abort.abort()
  signal.addEventListener('abort', stop)
  const timer = setTimeout(stop, DIRECT_TIMEOUT_MS)
  try {
    let target = source
    for (let hop = 0; hop <= 5; hop++) {
      if (!publicImageUrl(target)) throw imageFailure(-1)
      const response = await fetch(target, { signal: abort.signal, redirect: 'manual' }).catch(() => { throw imageFailure(502) })
      const next = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (!next) return await bytesOf(response)
      target = new URL(next, target).toString()
    }
    throw imageFailure(502)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

async function throughDaemon(context: GithubImageContext, source: string, signal: AbortSignal) {
  const client = prClient(context.projectId)
  if (!client) throw imageFailure(0)
  const query = new URLSearchParams({ project_id: context.projectId, url: source, number: String(context.number), ...(context.repo ? { repo: context.repo } : {}) })
  const response = await client.fetch(`/github/image?${query}`, { signal }).catch(() => { throw imageFailure(0) })
  // A daemon from before the route answers a bare 404: a public image still loads from here.
  if ((response.status === 404 || response.status === 405) && !(await response.clone().text().catch(() => '')).trim()) return direct(source, signal)
  return bytesOf(response)
}

export async function loadGithubImage(context: GithubImageContext | null, source: string, signal: AbortSignal): Promise<Loaded> {
  if (!loadable(source)) throw imageFailure(-1)
  const { media, bytes } = context && onGithub(source) ? await throughDaemon(context, source, signal) : await direct(source, signal)
  return { source: await storeImageBytes(bytes, media) }
}

const cache = new Map<string, Loaded>()
function remember(key: string, value: Loaded) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
}

/** The image as a cached file once loaded, or why it could not load; `retry` loads it again. */
export function useGithubImage(context: GithubImageContext | null, source: string) {
  const key = `${context?.projectId ?? ''}/${context?.repo ?? ''}:${context?.number ?? 0}:${source}`
  const [state, setState] = useState<{ key: string; image?: Loaded; failure?: ImageFailure; attempt: number }>(() => ({ key, image: cache.get(key), attempt: 0 }))
  const current = state.key === key ? state : { key, image: cache.get(key), attempt: 0 }
  useEffect(() => {
    const hit = cache.get(key)
    if (hit) { setState(s => (s.key === key && s.image === hit ? s : { key, image: hit, attempt: 0 })); return }
    const abort = new AbortController(), attempt = current.attempt
    void loadGithubImage(context, source, abort.signal).then(image => {
      if (abort.signal.aborted) return
      remember(key, image)
      setState({ key, image, attempt })
    }, (failure: ImageFailure | Error) => {
      if (abort.signal.aborted) return
      setState({ key, failure: 'reason' in failure ? failure : imageFailure(500), attempt })
    })
    return () => abort.abort()
    // `attempt` changes only through Retry, which loads again.
  }, [key, current.attempt])
  return { ...current, retry: () => setState({ key, attempt: current.attempt + 1 }) }
}
