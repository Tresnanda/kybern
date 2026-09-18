/** Inline compact/default decode budget. Matches the daemon's 560×352 preview
 * used for local thread images. 280 CSS px at 2× is 560 device px. */

export const PREVIEW_MAX_WIDTH = 560
export const PREVIEW_MAX_HEIGHT = 352
/** Tiny data URLs already fit the chip; keep src identity without a decode pass. */
export const PREVIEW_INLINE_PASSTHROUGH_CHARS = 16_384

export function previewFitSize(width: number, height: number, maxWidth = PREVIEW_MAX_WIDTH, maxHeight = PREVIEW_MAX_HEIGHT): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function previewUsesSource(source: string): boolean {
  return source.startsWith("data:") && source.length <= PREVIEW_INLINE_PASSTHROUGH_CHARS
}

export function previewNeedsFit(source: string): boolean {
  return !!source && (source.startsWith("data:") || source.startsWith("blob:")) && !previewUsesSource(source)
}

export async function inlineImageBlob(source: string, signal?: AbortSignal): Promise<Blob> {
  const data = source.match(/^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([a-z0-9+/=\s]+)$/i)
  if (data) {
    const binary = atob(data[2]!.replace(/\s/g, ""))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new Blob([bytes], { type: data[1]!.toLowerCase() })
  }
  const response = await fetch(source, { signal, referrerPolicy: "no-referrer" })
  if (!response.ok) throw new Error(`Image request failed with ${response.status}`)
  return response.blob()
}

export async function fitImageBlob(blob: Blob, maxWidth: number, maxHeight: number, signal?: AbortSignal): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return blob
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(blob)
    if (signal?.aborted) return blob
    const next = previewFitSize(bitmap.width, bitmap.height, maxWidth, maxHeight)
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
