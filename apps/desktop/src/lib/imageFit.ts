/** Thumbnail decode budget for 64 CSS-pixel composer/user chips (2× = 128). */

export const THUMBNAIL_MAX_EDGE = 128
/** Tiny data URLs already fit the chip; keep src identity without a decode pass. */
export const THUMBNAIL_INLINE_PASSTHROUGH_CHARS = 16_384

export function thumbnailFitSize(width: number, height: number, maxEdge = THUMBNAIL_MAX_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxEdge / width, maxEdge / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function thumbnailUsesSource(source: string): boolean {
  return source.startsWith("data:") && source.length <= THUMBNAIL_INLINE_PASSTHROUGH_CHARS
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
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    if (width === bitmap.width && height === bitmap.height) return blob
    bitmap.close()
    bitmap = undefined
    bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" })
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
