import type { MediaRef } from "./types.ts"

export interface ResponseImage { source: string; label: string }
const MIME = /^image\/(png|jpe?g|gif|webp|avif)$/i
const decodePath = (path: string) => { try { return decodeURIComponent(path) } catch { return path } }

/** The key of the object that stands where a stored tool result's base64 was (#298). */
export const MEDIA_REF_KEY = "kybern_media"
const ASSET_PREFIX = "kybern://asset/"

/** The reference a `{ kybern_media: … }` object holds, or null. */
export function mediaRef(value: unknown): MediaRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== MEDIA_REF_KEY) return null
  const media = (value as Record<string, unknown>)[MEDIA_REF_KEY] as Partial<MediaRef> | null
  return media && typeof media.hash === "string" && /^[0-9a-f]{64}$/.test(media.hash) && typeof media.mime === "string"
    ? { hash: media.hash, mime: media.mime, size: Number(media.size ?? 0), ...(media.encoding ? { encoding: media.encoding } : {}) }
    : null
}

/** The client-side source of a stored file: `kybern://asset/<id>`, fetched from the thread's owning machine as
 *  `/assets/<id>` with that machine's credentials. Never persisted. */
export function assetSource(id: string): string { return `${ASSET_PREFIX}${id}` }
export function mediaSource(media: MediaRef): string { return assetSource(media.hash) }
/** The daemon path of an asset source, or null. */
export function assetPath(source: string): string | null {
  return source.startsWith(ASSET_PREFIX) && /^[0-9a-zA-Z-]{1,80}$/.test(source.slice(ASSET_PREFIX.length)) ? `/assets/${source.slice(ASSET_PREFIX.length)}` : null
}

export function imageSource(source: string): { kind: "remote" | "inline" | "local" | "asset"; value: string } | null {
  if (source.length > 70_000_000) return null
  const asset = assetPath(source)
  if (asset) return { kind: "asset", value: asset }
  if (/^data:image\/(png|jpe?g|gif|webp|avif)(?:;[a-z0-9!#$&^_.+-]+=[^;,]+)*;base64,[a-z0-9+/=\s]+$/i.test(source)) return { kind: "inline", value: source }
  if (/^https?:\/\//i.test(source)) return { kind: "remote", value: source }
  if (/^file:\/\//i.test(source)) {
    try { const url = new URL(source); return !url.hostname || url.hostname === "localhost" ? { kind: "local", value: decodePath(url.pathname) } : null } catch { return null }
  }
  // A Windows drive path (`D:\cache\a.png`) is a file, not a `d:` scheme.
  if (/^[a-z]:[\\/]/i.test(source)) return { kind: "local", value: source }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("//") || !source.trim()) return null
  try { return { kind: "local", value: decodeURIComponent(source) } } catch { return { kind: "local", value: source } }
}
export function responseImages(value: unknown): ResponseImage[] {
  const found = new Map<string, ResponseImage>()
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 10 || found.size >= 32) return
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return }
    const o = value as Record<string, unknown>
    const raw = o.source && typeof o.source === "object" ? o.source as Record<string, unknown> : o
    const mime = String(raw.mimeType ?? raw.media_type ?? raw.mime ?? "")
    // Bytes stored outside the event log (#298) stand as `{ kybern_media }` where the base64 was.
    const stored = [raw.data, raw.base64, o.result, raw.url, o.image_url].map(mediaRef).find((media) => media && MIME.test(media.mime))
    let source = ""
    if (stored) source = mediaSource(stored)
    else if (o.type === "image" && typeof raw.data === "string" && MIME.test(mime)) source = `data:${mime};base64,${raw.data}`
    else if (MIME.test(mime) && typeof raw.url === "string") source = raw.url
    // Claude's Read result repeats the picture as `file: { base64, type }`; the same bytes give the same source, so it is shown once.
    else if (typeof raw.base64 === "string" && MIME.test(String(raw.type ?? ""))) source = `data:${raw.type};base64,${raw.base64}`
    else if (o.type === "image" && raw.type === "url" && typeof raw.url === "string") source = raw.url
    else if (o.type === "imageGeneration" && typeof o.result === "string") source = `data:image/${o.outputFormat === "jpeg" || o.outputFormat === "webp" ? o.outputFormat : "png"};base64,${o.result}`
    else if ((o.type === "imageView" || o.type === "imageGeneration") && typeof o.path === "string") source = o.path
    if (source && imageSource(source)) found.set(source, { source, label: String(o.filename ?? o.title ?? "Agent image") })
    if (mediaRef(o)) return
    for (const [key, child] of Object.entries(o)) if (!["data", "result", "base64"].includes(key) || typeof child === "object") visit(child, depth + 1)
  }
  visit(value, 0)
  return [...found.values()]
}

/** JSON replacer: omit image bytes without cloning the whole result first. */
export function imageSafeValue(this: unknown, key: string, child: unknown): unknown {
  const record = this as Record<string, unknown> | null
  if (!Array.isArray(record) && typeof child === "string" && isImageBytes(record, key, child)) return "[Image shown above]"
  const media = mediaRef(child)
  if (media) return storedLabel(media)
  return child
}

/** What the text view shows where stored bytes stand. */
function storedLabel(media: MediaRef): string {
  return MIME.test(media.mime) ? "[Image shown above]" : `[${media.mime === "application/pdf" ? "PDF" : "File"}, ${Math.max(1, Math.round(media.size / 1024))} KB]`
}

/** A string that is an image's bytes: a `data:` URL, base64 `data`, a generated image's `result`, or Claude's Read result
 *  `file.base64` (`{ base64, type: "image/png" }`), which otherwise reached the text view as one line of base64 megabytes long. */
function isImageBytes(record: Record<string, unknown> | null, key: string, child: string): boolean {
  return child.startsWith("data:image/") || (key === "data" && (record?.type === "base64" || record?.type === "image")) || (key === "result" && record?.type === "imageGeneration")
    || (key === "base64" && MIME.test(String(record?.type ?? "")))
}

/** Keep binary payloads out of the expandable text view; the gallery displays them. */
export function imageSafeOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(imageSafeOutput)
  if (!value || typeof value !== "object") return value
  const media = mediaRef(value)
  if (media) return storedLabel(media)
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if (typeof child === "string" && isImageBytes(record, key, child)) return [key, "[Image shown above]"]
    return [key, imageSafeOutput(child)]
  }))
}

/** Only supported raster-image file links enter the image preview route. */
export function localImageLink(source: string): boolean {
  const target = imageSource(source)
  return target?.kind === "local" && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(target.value)
}

export function responseImageError(error: unknown): { message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : "Unable to load image. Try again."
  if (message.startsWith("Preview unavailable")) return { message, retryable: false }
  if (message === "use a PNG, JPEG, GIF, WebP, or AVIF image" || message === "images are limited to 50 MB") return { message, retryable: false }
  return { message, retryable: true }
}
