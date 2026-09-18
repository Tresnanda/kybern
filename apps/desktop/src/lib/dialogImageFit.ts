/** Dialog decode budget for the open preview. `max-w-[min(90vw,1200px)]` by
 * `max-h-[75dvh]` at 1440×900 2× is 2400×1350 device pixels. Copy and download
 * keep the original bytes; only the displayed `<img>` is fitted. */

export const DIALOG_MAX_WIDTH = 2400
export const DIALOG_MAX_HEIGHT = 1350
/** Tiny data URLs already fit the dialog; keep src identity without a decode pass. */
export const DIALOG_INLINE_PASSTHROUGH_CHARS = 16_384

export function dialogFitSize(width: number, height: number, maxWidth = DIALOG_MAX_WIDTH, maxHeight = DIALOG_MAX_HEIGHT): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function dialogUsesSource(source: string): boolean {
  return source.startsWith("data:") && source.length <= DIALOG_INLINE_PASSTHROUGH_CHARS
}

function gifSource(source: string, blob?: Blob): boolean {
  const mime = (blob?.type.split(";", 1)[0] ?? "").toLowerCase()
  return mime === "image/gif" || /^data:image\/gif;/i.test(source) || /\.gif(?:[?#]|$)/i.test(source)
}

/** Animated GIFs stay on the original source so the dialog does not freeze them. */
export function dialogSkipFit(source: string, blob?: Blob): boolean {
  return gifSource(source, blob)
}

export function dialogNeedsFit(source: string): boolean {
  return !!source && (source.startsWith("data:") || source.startsWith("blob:")) && !dialogUsesSource(source) && !dialogSkipFit(source)
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
  if (gifSource("", blob) || typeof createImageBitmap !== "function") return blob
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(blob)
    if (signal?.aborted) return blob
    const next = dialogFitSize(bitmap.width, bitmap.height, maxWidth, maxHeight)
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
