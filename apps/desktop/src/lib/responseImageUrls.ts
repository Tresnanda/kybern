/** Owned object URLs for thread images. Live decoded consumers are refcounted;
 * idle compressed blobs are a separate reconstructible cache from tool-output LRU. */

export const PREVIEW_MAX_WIDTH = 560
export const PREVIEW_MAX_HEIGHT = 352
export const MAX_IDLE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_IDLE_IMAGE_ENTRIES = 12

export type ResponseImageVariant = "preview" | "original"

export function responseImageUrlKey(threadId: string | null, source: string, variant: ResponseImageVariant): string {
  return JSON.stringify([threadId, source, variant])
}

export function previewFitSize(width: number, height: number, maxWidth = PREVIEW_MAX_WIDTH, maxHeight = PREVIEW_MAX_HEIGHT): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export interface AcquiredResponseImage {
  url: string
  owned: boolean
}

export interface ResponseImageUrlOptions {
  maxIdleBytes?: number
  maxIdleEntries?: number
  fitPreview?: (blob: Blob, signal: AbortSignal) => Promise<Blob>
}

interface IdleBlob { blob: Blob; bytes: number; sourceUrl?: string }
interface LiveUrl { url: string; blob: Blob; consumers: number; owned: boolean; sourceUrl?: string }
interface InFlight {
  controller: AbortController
  waiters: number
  promise: Promise<Blob>
  blob?: Blob
}
function abortError(): DOMException {
  return new DOMException("The image request was cancelled.", "AbortError")
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError())
    else signal.addEventListener("abort", () => reject(abortError()), { once: true })
  })
}

export function createResponseImageUrls({
  maxIdleBytes = MAX_IDLE_IMAGE_BYTES,
  maxIdleEntries = MAX_IDLE_IMAGE_ENTRIES,
  fitPreview = fitPreviewBlob,
}: ResponseImageUrlOptions = {}) {
  const idle = new Map<string, IdleBlob>()
  const live = new Map<string, LiveUrl>()
  const inflight = new Map<string, InFlight>()
  let idleBytes = 0
  let disposed = false

  function park(key: string, blob: Blob, sourceUrl?: string): void {
    if (disposed) return
    const bytes = blob.size
    const previous = idle.get(key)
    if (previous) { idle.delete(key); idleBytes -= previous.bytes }
    if (bytes > maxIdleBytes) return
    idle.set(key, { blob, bytes, sourceUrl })
    idleBytes += bytes
    for (const [oldest, entry] of idle) {
      if (idle.size <= maxIdleEntries && idleBytes <= maxIdleBytes) break
      idle.delete(oldest)
      idleBytes -= entry.bytes
    }
  }

  async function acquire(key: string, load: (signal: AbortSignal) => Promise<Blob>, signal: AbortSignal, preview = false, sourceUrl?: string): Promise<AcquiredResponseImage> {
    if (disposed) throw abortError()
    const existing = live.get(key)
    if (existing) {
      existing.consumers++
      return { url: existing.url, owned: existing.owned }
    }

    const parked = idle.get(key)
    let blob: Blob
    let passthrough = parked?.sourceUrl
    if (parked) {
      idle.delete(key)
      idleBytes -= parked.bytes
      blob = parked.blob
    } else {
      let job = inflight.get(key)
      if (!job) {
        const controller = new AbortController()
        const current: InFlight = {
          controller,
          waiters: 0,
          promise: load(controller.signal).then((blob) => {
            current.blob = blob
            return blob
          }).finally(() => { if (inflight.get(key) === current) inflight.delete(key) }),
        }
        inflight.set(key, current)
        job = current
      }
      const pending = job
      pending.waiters++
      passthrough = sourceUrl
      const onAbort = () => {
        pending.waiters--
        if (pending.waiters <= 0) pending.controller.abort()
      }
      if (signal.aborted) { onAbort(); throw abortError() }
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        blob = await Promise.race([pending.promise, whenAborted(signal)])
      } catch (error) {
        if (signal.aborted) {
          if (pending.blob) park(key, pending.blob, passthrough)
          throw abortError()
        }
        throw error
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    }
    if (signal.aborted) { park(key, blob, passthrough); throw abortError() }

    const loaded = blob
    if (preview) {
      try { blob = await fitPreview(blob, signal) } catch { /* keep the loaded blob */ }
      if (signal.aborted) { park(key, blob, blob === loaded ? passthrough : undefined); throw abortError() }
      if (blob !== loaded) passthrough = undefined
    }

    const shared = live.get(key)
    if (shared) {
      shared.consumers++
      park(key, blob, passthrough)
      return { url: shared.url, owned: shared.owned }
    }
    const owned = !passthrough
    const url = passthrough ?? URL.createObjectURL(blob)
    live.set(key, { url, blob, consumers: 1, owned, sourceUrl: passthrough })
    return { url, owned }
  }

  function release(key: string): void {
    const entry = live.get(key)
    if (!entry) return
    entry.consumers--
    if (entry.consumers > 0) return
    live.delete(key)
    if (entry.owned) URL.revokeObjectURL(entry.url)
    park(key, entry.blob, entry.sourceUrl)
  }

  function dispose(): void {
    disposed = true
    for (const job of inflight.values()) job.controller.abort()
    inflight.clear()
    for (const entry of live.values()) if (entry.owned) URL.revokeObjectURL(entry.url)
    live.clear()
    idle.clear()
    idleBytes = 0
  }

  return {
    acquire,
    release,
    dispose,
    stats() {
      let liveBytes = 0
      for (const entry of live.values()) liveBytes += entry.blob.size
      return { live: live.size, liveBytes, idle: idle.size, idleBytes, inflight: inflight.size }
    },
  }
}

async function fitPreviewBlob(blob: Blob, signal: AbortSignal): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return blob
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(blob)
    if (signal.aborted) return blob
    const next = previewFitSize(bitmap.width, bitmap.height)
    if (next.width === bitmap.width && next.height === bitmap.height) return blob
    bitmap.close()
    bitmap = undefined
    bitmap = await createImageBitmap(blob, { resizeWidth: next.width, resizeHeight: next.height, resizeQuality: "high" })
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext("2d")
    if (!context) return blob
    context.drawImage(bitmap, 0, 0)
    const fitted = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    return fitted ?? blob
  } catch {
    return blob
  } finally {
    bitmap?.close()
  }
}

let urls = createResponseImageUrls()
export const acquireResponseImageUrl: typeof urls.acquire = (...args) => urls.acquire(...args)
export const releaseResponseImageUrl: typeof urls.release = (...args) => urls.release(...args)
export const responseImageUrlStats = () => urls.stats()
export function resetResponseImageUrls(options?: ResponseImageUrlOptions): void {
  urls.dispose()
  urls = createResponseImageUrls(options)
}
