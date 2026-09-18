import { useEffect, useState } from "react"
import { fetchAssetImage } from "@/state/rpc"
import { ResponseImage } from "./ResponseImage"

/** Drafts retain asset IDs, not blob URLs. Recreate the preview only while mounted. */
export function ComposerImageAttachment({ id, name, preview }: { id: string; name: string; preview?: string }) {
  const [restored, setRestored] = useState("")
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (preview) return
    const controller = new AbortController()
    let ownedUrl = ""
    void (async () => {
      const blob = await fetchAssetImage(id, controller.signal)
      if (controller.signal.aborted) return
      ownedUrl = URL.createObjectURL(blob)
      setRestored(ownedUrl)
    })().catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => {
      controller.abort()
      if (ownedUrl) URL.revokeObjectURL(ownedUrl)
    }
  }, [id, preview, attempt])

  const source = preview || restored
  if (source) return <ResponseImage source={source} label={name} thumbnail />
  return <button type="button" disabled={!failed} aria-label={failed ? `Retry preview ${name}` : `Loading preview ${name}`} onClick={() => { setFailed(false); setAttempt(value => value + 1) }} className="flex size-16 items-center justify-center rounded-xl bg-[var(--composer-surface)] p-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span className="min-w-0 truncate">{failed ? "Retry preview" : name}</span>
  </button>
}
