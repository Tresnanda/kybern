import { useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Dialog, DialogClose, DialogPopup, DialogTitle, DialogDescription } from "@/components/kit/dialog"
import { Button } from "@/components/kit/button"
import { IconButton } from "@/components/kit/icon-button"
import { IconSwap } from "@/components/kybern/motion"
import { CheckIcon, CopyIcon, DownloadIcon, XIcon } from "@/lib/kit/icons"
import { ImageThreadContext } from "@/lib/imageThread"
import { imageSource, responseImageError } from "@/lib/responseImages"
import { acquireResponseImageUrl, releaseResponseImageUrl, responseImageUrlKey } from "@/lib/responseImageUrls"
import { isTauri, platform, saveImageFile, writeImageClipboard } from "@/lib/tauri"
import { fetchThreadImage } from "@/state/rpc"
import { cn } from "@/lib/utils"

type ImageError = { message: string; retryable: boolean }
type ImageAction = "copy" | "download"

function imageMime(value: string): string | null {
  const direct = value.match(/^image\/(png|jpeg|gif|webp|avif)(?:[;,]|$)/i)?.[0]
  if (direct) return direct.split(/[;,]/, 1)[0]!.toLowerCase()
  const extension = value.match(/\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i)?.[1]?.toLowerCase()
  if (!extension) return null
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`
}

function imageDownloadName(label: string, source: string, mime: string): string {
  const safeLabel = label.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "image"
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(safeLabel)) return safeLabel
  return `${safeLabel}.${mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1] || imageMime(source)?.split("/")[1] || "png"}`
}

async function fetchImageBlob(source: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(source, { signal, referrerPolicy: "no-referrer" })
  if (!response.ok) throw new Error(`Image request failed with ${response.status}`)
  const blob = await response.blob()
  const mime = imageMime(blob.type) ?? imageMime(source) ?? "image/png"
  return imageMime(blob.type) === mime ? blob : new Blob([blob], { type: mime })
}

/** Clipboard image writes use PNG because Safari does not promise other image types. */
async function fetchPng(source: string): Promise<Blob> {
  const blob = await fetchImageBlob(source)
  if (imageMime(blob.type) === "image/png") return blob

  let objectUrl = ""
  let drawable: ImageBitmap | HTMLImageElement | null = null
  const loadImageElement = async (): Promise<HTMLImageElement> => {
    objectUrl = URL.createObjectURL(blob)
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error("Image format cannot be converted to PNG"))
      image.src = objectUrl
    })
  }
  try {
    if (typeof createImageBitmap === "function") {
      try { drawable = await createImageBitmap(blob) } catch { drawable = await loadImageElement() }
    } else {
      drawable = await loadImageElement()
    }
    const canvas = document.createElement("canvas")
    canvas.width = drawable.width
    canvas.height = drawable.height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Image conversion is not available in this window.")
    context.drawImage(drawable, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Image format cannot be converted to PNG")), "image/png")
    })
  } finally {
    if (drawable && "close" in drawable) drawable.close()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

/** Local previews and originals share the authenticated thread boundary. */
export function ResponseImage({ source, label = "Agent image", compact = false, thumbnail = false, linkLabel }: { source: string; label?: string; compact?: boolean; thumbnail?: boolean; linkLabel?: ReactNode }) {
  const threadId = useContext(ImageThreadContext)
  return <ImageContent key={`${threadId}:${source}`} source={source} label={label} threadId={threadId} compact={compact} thumbnail={thumbnail} linkLabel={linkLabel} />
}

function ImageContent({ source, label, threadId, compact, thumbnail, linkLabel }: { source: string; label: string; threadId: string | null; compact: boolean; thumbnail: boolean; linkLabel?: ReactNode }) {
  const target = thumbnail && source.startsWith("blob:") ? { kind: "inline" as const, value: source } : imageSource(source)
  const isLink = linkLabel !== undefined
  const direct = target && target.kind !== "local" ? target.value : ""
  const initialError: ImageError | null = !target ? { message: "This image format is not supported.", retryable: false }
    : target.kind === "local" && !threadId ? { message: "Open the image from its conversation.", retryable: false } : null
  const preview = useRef<HTMLSpanElement>(null)
  const [requested, setRequested] = useState(false)
  const [retry, setRetry] = useState(0)
  const [url, setUrl] = useState("")
  const [error, setError] = useState(initialError)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [original, setOriginal] = useState("")
  const [originalError, setOriginalError] = useState(initialError)
  const [originalRetry, setOriginalRetry] = useState(0)
  const [imageAction, setImageAction] = useState<ImageAction | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
  }, [])

  useEffect(() => {
    if (isLink || !preview.current) return
    const observer = new IntersectionObserver(([entry]) => {
      setRequested(!!entry?.isIntersecting)
    }, { rootMargin: "300px" })
    observer.observe(preview.current)
    return () => observer.disconnect()
  }, [isLink])

  useEffect(() => {
    const target = thumbnail && source.startsWith("blob:") ? { kind: "inline" as const, value: source } : imageSource(source)
    // data:/blob:/https? sources keep their original src. Fetching them to mint a
    // preview URL can change WebKit's img.src identity and fails chat-fixes.
    if (!requested || isLink || target?.kind !== "local" || !threadId) return
    const key = responseImageUrlKey(threadId, source, "preview")
    const controller = new AbortController()
    let held = false
    void acquireResponseImageUrl(key, (signal) => fetchThreadImage(threadId, target.value, signal, true), controller.signal, true).then((acquired) => {
      if (controller.signal.aborted) {
        releaseResponseImageUrl(key)
        return
      }
      held = true
      setUrl(acquired.url)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(responseImageError(error)) })
    return () => {
      controller.abort()
      if (held) releaseResponseImageUrl(key)
      setUrl("")
      setLoaded(false)
    }
  }, [source, threadId, requested, retry, isLink, thumbnail])

  useEffect(() => {
    const target = thumbnail && source.startsWith("blob:") ? { kind: "inline" as const, value: source } : imageSource(source)
    if (!open || target?.kind !== "local" || !threadId) return
    const key = responseImageUrlKey(threadId, source, "original")
    const controller = new AbortController()
    let held = false
    void acquireResponseImageUrl(key, (signal) => fetchThreadImage(threadId, target.value, signal), controller.signal).then((acquired) => {
      if (controller.signal.aborted) {
        releaseResponseImageUrl(key)
        return
      }
      held = true
      setOriginal(acquired.url)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setOriginalError(responseImageError(error)) })
    return () => {
      controller.abort()
      if (held) releaseResponseImageUrl(key)
      setOriginal("")
    }
  }, [source, threadId, open, originalRetry, thumbnail])

  // Opening the dialog must not remount the trigger. `requested || open` turned
  // an offscreen "Preview image" button into an <img> button and Base UI closed.
  const previewUrl = !requested || isLink ? "" : direct || url
  const originalUrl = !open ? "" : direct || original

  const changeOpen = (next: boolean) => {
    if (next) {
      setOriginalError(initialError)
      setImageAction(null)
      setCopied(false)
    } else {
      setOriginal("")
      setOriginalError(initialError)
    }
    setOpen(next)
  }
  const retryPreview = () => { setError(null); setLoaded(false); setUrl(""); setRetry((n) => n + 1) }
  const retryOriginal = () => { setOriginalError(null); setOriginal(""); setOriginalRetry((n) => n + 1) }
  const displayError = (): ImageError => ({ message: "Unable to display image. Check that the file is still available, then retry.", retryable: true })
  const runImageAction = async (kind: ImageAction) => {
    if (!originalUrl || imageAction) return
    setImageAction(kind)
    try {
      if (kind === "copy") {
        if (isTauri() && platform() === "macos") {
          // The Tauri custom scheme does not consistently expose WebKit's
          // image clipboard API. Keep the conversion native-independent, then
          // send the PNG directly to AppKit without relying on activation.
          const nativePng = await fetchPng(originalUrl)
          await writeImageClipboard(new Uint8Array(await nativePng.arrayBuffer()))
        } else {
          if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
            throw new Error("Image copying is not available in this window.")
          }
          // ClipboardItem accepts a promise. Construct it and call write before
          // awaiting anything so WebKit keeps the click's user activation.
          const png = fetchPng(originalUrl)
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
        }
        setCopied(true)
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
        copiedTimer.current = window.setTimeout(() => {
          copiedTimer.current = null
          setCopied(false)
        }, 1400)
      } else {
        const image = await fetchImageBlob(originalUrl)
        const mime = imageMime(image.type) ?? imageMime(source) ?? "image/png"
        const nativeSave = await saveImageFile(new Uint8Array(await image.arrayBuffer()), imageDownloadName(label, source, mime))
        if (nativeSave !== null) return
        const downloadUrl = URL.createObjectURL(image)
        const link = document.createElement("a")
        link.href = downloadUrl
        link.download = imageDownloadName(label, source, mime)
        document.body.append(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0)
      }
    } catch {
      toast.error(kind === "copy" ? "Unable to copy image" : "Unable to download image", {
        description: kind === "copy" ? "Use Download image instead, or check clipboard permissions." : "Check that the image is still available, then retry.",
      })
    } finally {
      setImageAction(null)
    }
  }
  const status = (error: ImageError | null, retry: () => void, inline = false) => error
    ? <span role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-background-button-secondary)] p-3 text-sm">
      <span>{label}: {error.message}</span>
      {error.retryable && <Button type="button" variant="ghost" size="sm" onClick={retry}>Retry</Button>}
      {inline && error.message.startsWith("Preview unavailable") && <Button type="button" variant="ghost" size="sm" onClick={() => changeOpen(true)}>Open original</Button>}
    </span>
    : <span role="status" className="block rounded-lg bg-[var(--color-background-button-secondary)] p-4 text-sm text-muted-foreground">Loading image…</span>

  const previewButton = (
    <button
      type="button"
      aria-label={`Preview ${label}`}
      className={cn(
        "response-image-preview outline-none focus-visible:ring-2 focus-visible:ring-ring",
        thumbnail ? "response-image-thumbnail rounded-xl" : compact ? "rounded-lg" : "rounded-xl",
        previewUrl && !error ? "cursor-zoom-in" : thumbnail ? "p-1 text-xs text-muted-foreground" : "",
      )}
      onClick={() => changeOpen(true)}
    >
      {error || !previewUrl
        ? "Preview image"
        : <img key={retry} src={previewUrl} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setError(displayError())} data-loaded={!!previewUrl && loaded} className={cn("t-img max-w-full object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10", compact ? "rounded-lg" : "rounded-xl")} />}
    </button>
  )

  return <span ref={preview} className={isLink ? "inline" : thumbnail ? "block size-16 shrink-0" : compact ? "block w-[280px] max-w-full" : "my-3 block w-[280px] max-w-full"}>
    {isLink ? <a href={source} className="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline" onClick={(event) => { event.preventDefault(); changeOpen(true) }}>{linkLabel}</a>
      : thumbnail ? previewButton
      : !error && !previewUrl && !requested ? <span className="response-image-preview" />
      : error || !previewUrl ? <span className="response-image-preview">{status(error, retryPreview, true)}</span>
      : previewButton}
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogPopup showCloseButton={false} finalFocus={() => preview.current?.querySelector<HTMLElement>("button, a") ?? null} className="max-w-[min(90vw,1200px)] p-4">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{label}</DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
          {originalUrl && !originalError && <>
            <IconButton
              type="button"
              variant="ghost"
              size="icon-sm"
              label={copied ? "Image copied" : "Copy image"}
              tooltip={copied ? "Image copied" : "Copy image"}
              disabled={imageAction !== null}
              onClick={() => void runImageAction("copy")}
            >
              <IconSwap className="size-3.5" active={copied ? "b" : "a"} a={<CopyIcon className="size-3.5" />} b={<CheckIcon className="size-3.5 text-success" />} />
            </IconButton>
            <IconButton
              type="button"
              variant="ghost"
              size="icon-sm"
              label="Download image"
              tooltip="Download image"
              disabled={imageAction !== null}
              onClick={() => void runImageAction("download")}
            >
              <DownloadIcon className="size-3.5" />
            </IconButton>
          </>}
            <DialogClose render={<IconButton label="Close" tooltip="Close" size="icon-sm" />}>
              <XIcon className="size-3.5" />
            </DialogClose>
          </div>
        </div>
        <DialogDescription className="sr-only">Image preview. Press Escape to close.</DialogDescription>
        {originalError || !originalUrl ? status(originalError, retryOriginal) : <img key={originalRetry} src={originalUrl} alt={label} referrerPolicy="no-referrer" onError={() => setOriginalError(displayError())} className="mt-3 max-h-[75dvh] w-full rounded-lg object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10" />}
      </DialogPopup>
    </Dialog>
  </span>
}
