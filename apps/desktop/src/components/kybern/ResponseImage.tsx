import { useContext, useEffect, useState, type ReactNode } from "react"
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "@/components/kit/dialog"
import { Button } from "@/components/kit/button"
import { ImageThreadContext } from "@/lib/imageThread"
import { imageSource, responseImageError } from "@/lib/responseImages"
import { fetchThreadImage } from "@/state/rpc"
import { cn } from "@/lib/utils"

/** Local image links use the same authenticated, thread-scoped preview as inline images. */
export function ResponseImage({ source, label = "Agent image", compact = false, linkLabel }: { source: string; label?: string; compact?: boolean; linkLabel?: ReactNode }) {
  const threadId = useContext(ImageThreadContext)
  return <ImageContent key={`${threadId}:${source}`} source={source} label={label} threadId={threadId} compact={compact} linkLabel={linkLabel} />
}

function ImageContent({ source, label, threadId, compact, linkLabel }: { source: string; label: string; threadId: string | null; compact: boolean; linkLabel?: ReactNode }) {
  const target = imageSource(source)
  const isLink = linkLabel !== undefined
  const [requested, setRequested] = useState(!isLink)
  const [retry, setRetry] = useState(0)
  const [url, setUrl] = useState(target && target.kind !== "local" ? target.value : "")
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(!target ? { message: "This image format is not supported.", retryable: false } : target.kind === "local" && !threadId ? { message: "Open the image from its conversation.", retryable: false } : null)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ""
    const target = imageSource(source)
    if (!requested || !target || target.kind !== "local" || !threadId) return
    void fetchThreadImage(threadId, target.value, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(responseImageError(error)) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [source, threadId, requested, retry])
  const onRetry = () => {
    setError(null)
    setLoaded(false)
    setUrl(target && target.kind !== "local" ? target.value : "")
    setRetry((n) => n + 1)
  }
  const onImageError = () => setError({ message: "Unable to display image. Check that the file is still available, then retry.", retryable: true })
  const status = error
    ? <span role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-background-button-secondary)] p-3 text-sm"><span>{label}: {error.message}</span>{error.retryable && <Button type="button" variant="ghost" size="sm" onClick={onRetry}>Retry</Button>}</span>
    : <span role="status" className="block rounded-lg bg-[var(--color-background-button-secondary)] p-4 text-sm text-muted-foreground">Loading image…</span>
  return <span className={isLink ? "inline" : compact ? "block max-w-full" : "my-3 block max-w-full"}>
    {isLink ? <a href={source} className="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline" onClick={(event) => { event.preventDefault(); setRequested(true); setOpen(true) }}>{linkLabel}</a>
      : error || !url ? status
      : <button type="button" aria-label={`Preview ${label}`} className={cn("block max-w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? "rounded-lg" : "rounded-xl")} onClick={() => setOpen(true)}><img key={retry} src={url} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={onImageError} data-loaded={loaded} className={cn("t-img max-w-full object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10", compact ? "max-h-52 rounded-lg" : "max-h-96 rounded-xl")} /></button>}
    <Dialog open={open} onOpenChange={setOpen}><DialogPopup className="max-w-[min(90vw,1200px)] p-4"><DialogTitle className="pe-8 text-sm">{label}</DialogTitle><DialogDescription className="sr-only">Image preview. Press Escape to close.</DialogDescription>{error || !url ? status : <img key={retry} src={url} alt={label} referrerPolicy="no-referrer" onError={onImageError} className="mt-3 max-h-[75dvh] w-full rounded-lg object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10" />}</DialogPopup></Dialog>
  </span>
}
