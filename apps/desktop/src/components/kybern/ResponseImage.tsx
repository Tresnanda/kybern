import { useContext, useEffect, useState } from "react"
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "@/components/synara/dialog"
import { Button } from "@/components/synara/button"
import { ImageThreadContext } from "@/lib/imageThread"
import { imageSource } from "@/lib/responseImages"
import { fetchThreadImage } from "@/state/rpc"

export function ResponseImage({ source, label = "Agent image" }: { source: string; label?: string }) {
  const threadId = useContext(ImageThreadContext)
  const [retry, setRetry] = useState(0)
  return <ImageContent key={`${threadId}:${source}:${retry}`} source={source} label={label} threadId={threadId} onRetry={() => setRetry((n) => n + 1)} />
}

function ImageContent({ source, label, threadId, onRetry }: { source: string; label: string; threadId: string | null; onRetry: () => void }) {
  const target = imageSource(source)
  const [url, setUrl] = useState(target && target.kind !== "local" ? target.value : "")
  const [error, setError] = useState(!target ? "This image format is not supported." : target.kind === "local" && !threadId ? "Open the image from its conversation." : "")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ""
    const target = imageSource(source)
    if (!target || target.kind !== "local" || !threadId) return
    void fetchThreadImage(threadId, target.value, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to load image. Try again.") })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [source, threadId])
  return <span className="my-3 block max-w-full">
    {error ? <span role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-background-button-secondary)] p-3 text-sm"><span>{label}: {error}</span><Button type="button" variant="ghost" size="sm" onClick={onRetry}>Retry</Button></span>
      : url ? <button type="button" aria-label={`Preview ${label}`} className="block max-w-full cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpen(true)}><img src={url} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setError("Unable to display image. Check that the file is still available, then retry.")} className="max-h-96 max-w-full rounded-xl object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10" /></button>
      : <span role="status" className="block rounded-lg bg-[var(--color-background-button-secondary)] p-4 text-sm text-muted-foreground">Loading image…</span>}
    <Dialog open={open} onOpenChange={setOpen}><DialogPopup className="max-w-[min(90vw,1200px)] p-4"><DialogTitle className="pe-8 text-sm">{label}</DialogTitle><DialogDescription className="sr-only">Image preview. Press Escape to close.</DialogDescription>{url && <img src={url} alt={label} referrerPolicy="no-referrer" className="mt-3 max-h-[75dvh] w-full rounded-lg object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10" />}</DialogPopup></Dialog>
  </span>
}
