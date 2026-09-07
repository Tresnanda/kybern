import { useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "@/components/kit/dialog"
import { Button } from "@/components/kit/button"
import { ImageThreadContext } from "@/lib/imageThread"
import { imageSource, responseImageError } from "@/lib/responseImages"
import { fetchThreadImage } from "@/state/rpc"
import { cn } from "@/lib/utils"

type ImageError = { message: string; retryable: boolean }

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
  const [url, setUrl] = useState(direct)
  const [error, setError] = useState(initialError)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [original, setOriginal] = useState(direct)
  const [originalError, setOriginalError] = useState(initialError)
  const [originalRetry, setOriginalRetry] = useState(0)

  useEffect(() => {
    if (isLink || !preview.current) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setRequested(true); observer.disconnect() }
    }, { rootMargin: "300px" })
    observer.observe(preview.current)
    return () => observer.disconnect()
  }, [isLink])

  useEffect(() => {
    const target = imageSource(source)
    if (!requested || isLink || target?.kind !== "local" || !threadId) return
    const controller = new AbortController()
    let objectUrl = ""
    void fetchThreadImage(threadId, target.value, controller.signal, true).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(responseImageError(error)) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [source, threadId, requested, retry, isLink])

  useEffect(() => {
    const target = imageSource(source)
    if (!open || target?.kind !== "local" || !threadId) return
    const controller = new AbortController()
    let objectUrl = ""
    void fetchThreadImage(threadId, target.value, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setOriginal(objectUrl)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setOriginalError(responseImageError(error)) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [source, threadId, open, originalRetry])

  const changeOpen = (next: boolean) => {
    if (next) { setOriginal(direct); setOriginalError(initialError) }
    setOpen(next)
  }
  const retryPreview = () => { setError(null); setLoaded(false); setUrl(direct); setRetry((n) => n + 1) }
  const retryOriginal = () => { setOriginalError(null); setOriginal(direct); setOriginalRetry((n) => n + 1) }
  const displayError = (): ImageError => ({ message: "Unable to display image. Check that the file is still available, then retry.", retryable: true })
  const status = (error: ImageError | null, retry: () => void, inline = false) => error
    ? <span role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-background-button-secondary)] p-3 text-sm">
      <span>{label}: {error.message}</span>
      {error.retryable && <Button type="button" variant="ghost" size="sm" onClick={retry}>Retry</Button>}
      {inline && error.message.startsWith("Preview unavailable") && <Button type="button" variant="ghost" size="sm" onClick={() => changeOpen(true)}>Open original</Button>}
    </span>
    : <span role="status" className="block rounded-lg bg-[var(--color-background-button-secondary)] p-4 text-sm text-muted-foreground">Loading image…</span>

  return <span ref={preview} className={isLink ? "inline" : thumbnail ? "block size-16 shrink-0" : compact ? "block w-[280px] max-w-full" : "my-3 block w-[280px] max-w-full"}>
    {isLink ? <a href={source} className="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline" onClick={(event) => { event.preventDefault(); changeOpen(true) }}>{linkLabel}</a>
      : thumbnail && (error || !url) ? <button type="button" aria-label={`Preview ${label}`} className="response-image-preview response-image-thumbnail rounded-xl p-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => changeOpen(true)}>Preview image</button>
      : error || !url ? <span className="response-image-preview">{status(error, retryPreview, true)}</span>
      : <button type="button" aria-label={`Preview ${label}`} className={cn("response-image-preview cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring", thumbnail ? "response-image-thumbnail rounded-xl" : compact ? "rounded-lg" : "rounded-xl")} onClick={() => changeOpen(true)}>
        <img key={retry} src={url} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setError(displayError())} data-loaded={loaded} className={cn("t-img max-w-full object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10", compact ? "rounded-lg" : "rounded-xl")} />
      </button>}
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogPopup finalFocus={() => preview.current?.querySelector<HTMLElement>("button, a") ?? null} className="max-w-[min(90vw,1200px)] p-4">
        <DialogTitle className="pe-8 text-sm">{label}</DialogTitle>
        <DialogDescription className="sr-only">Image preview. Press Escape to close.</DialogDescription>
        {originalError || !original ? status(originalError, retryOriginal) : <img key={originalRetry} src={original} alt={label} referrerPolicy="no-referrer" onError={() => setOriginalError(displayError())} className="mt-3 max-h-[75dvh] w-full rounded-lg object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10" />}
      </DialogPopup>
    </Dialog>
  </span>
}
