// Images inside the editor. A `kybern://asset/<id>` image is read from the daemon
// that keeps the note (assets need its token), decoded natively once, and shared
// by every editor that shows it (`setRichEditorImage`). Adding an image uploads
// the file to that daemon first, like the desktop's `noteImage.ts`.
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'

/** Where a document's images live: the client of the daemon that keeps it. */
export interface ImageHome { endpoint: () => { url: string; token: string } | null }

const MAX_BYTES = 12 * 1024 * 1024
const loaded = new Map<string, Promise<void>>()
const pending = new Set<string>()
const LIMIT = 48

type ImageRenderer = { setRichEditorImage?: (src: string, bytes: Buffer) => void; hasRichEditorImage?: (src: string) => boolean } | null | undefined

/** Decode an image for the editors that show `src`; failures show "Image unavailable". */
export function loadEditorImage(renderer: unknown, home: ImageHome | null, src: string): Promise<void> {
  const native = renderer as ImageRenderer
  if (!native?.setRichEditorImage) return Promise.resolve()
  const cached = loaded.get(src)
  if (cached && (pending.has(src) || !native.hasRichEditorImage || native.hasRichEditorImage(src))) return cached
  if (!cached && native.hasRichEditorImage?.(src)) return Promise.resolve()
  loaded.delete(src)
  pending.add(src)
  const job = (async () => {
    try {
      let bytes: ArrayBuffer
      if (src.startsWith('kybern://asset/')) {
        const endpoint = home?.endpoint()
        if (!endpoint) throw Error('Images are unavailable here')
        const response = await fetch(`${httpBase(endpoint.url)}/assets/${encodeURIComponent(src.slice('kybern://asset/'.length))}`, { headers: { authorization: `Bearer ${endpoint.token}` } })
        if (!response.ok) throw Error(`Image unavailable (${response.status})`)
        bytes = await response.arrayBuffer()
      } else if (/^https?:\/\//i.test(src)) {
        const response = await fetch(src)
        if (!response.ok) throw Error(`Image unavailable (${response.status})`)
        bytes = await response.arrayBuffer()
      } else if (src.startsWith('data:image/')) {
        const decoded = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
        bytes = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer
      } else if (src.startsWith('/') || src.startsWith('file://')) {
        bytes = await Bun.file(src.replace(/^file:\/\//, '')).arrayBuffer()
      } else throw Error('Unsupported image address')
      if (bytes.byteLength > MAX_BYTES) throw Error('Image too large')
      native.setRichEditorImage!(src, Buffer.from(bytes))
    } catch {
      loaded.delete(src)
      native.setRichEditorImage?.(src, Buffer.alloc(0))
    }
  })().finally(() => {
    pending.delete(src)
    // A resolved promise must not pin a multi-megabyte data URL after closing
    // its editor. Native residency decides whether it needs loading again.
    if (src.length > 8192) loaded.delete(src)
  })
  loaded.set(src, job)
  while (loaded.size > LIMIT) loaded.delete(loaded.keys().next().value!)
  return job
}

/** Upload image files to the document's daemon; returns their `kybern://asset/` addresses. */
export async function uploadEditorImages(home: ImageHome, paths: string[]): Promise<{ src: string; alt: string }[]> {
  const endpoint = home.endpoint()
  if (!endpoint) throw Error('Reconnect to add images.')
  const out: { src: string; alt: string }[] = []
  for (const path of paths) {
    const file = Bun.file(path)
    const type = file.type.startsWith('image/') ? file.type : 'image/png'
    if (file.size > MAX_BYTES) throw Error('Choose an image smaller than 12 MB.')
    const name = path.split('/').pop() ?? 'Image'
    const response = await fetch(`${httpBase(endpoint.url)}/assets`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': type, 'x-kybern-filename': encodeURIComponent(name) }, body: await file.arrayBuffer() })
    if (!response.ok) throw Error(`Upload failed (${response.status})`)
    const asset = await response.json() as { id: string }
    // Pasted images arrive as temporary files; their name says nothing.
    out.push({ src: `kybern://asset/${asset.id}`, alt: name.startsWith('kybern-paste-') ? '' : name.replace(/\.[a-z0-9]+$/i, '') })
  }
  return out
}
