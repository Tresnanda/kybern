import { useEffect, useState } from "react"
import { fetchAssetImage } from "@/state/rpc"
import { useStore } from "@/state/store"
import { ResponseImage } from "./ResponseImage"

type ImageAttachmentProps = { id: string; name: string; preview?: string }

/** Drafts retain asset IDs, not blob URLs. Recreate the preview only while mounted. */
export function ComposerImageAttachment(props: ImageAttachmentProps) {
  const connected = useStore(state => state.connection.state === "open")
  if (!props.preview && !connected) return <span aria-label={`Waiting for connection to preview ${props.name}`} className="flex size-16 items-center justify-center rounded-xl bg-[var(--composer-surface)] p-1 text-xs text-muted-foreground"><span className="min-w-0 truncate">{props.name}</span></span>
  return <ConnectedImageAttachment {...props} />
}

function ConnectedImageAttachment({ id, name, preview }: ImageAttachmentProps) {
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
