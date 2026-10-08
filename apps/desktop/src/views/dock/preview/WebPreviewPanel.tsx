import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/kit/button"
import { PictureInPictureIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { usePreviewSession } from "@/state/previewSession"
import { useStore, type WebPreview } from "@/state/store"
import { DockEmpty } from "../DockParts"
import { PreviewPanel } from "../PreviewPanel"
import { PreviewChromeRow } from "./PreviewChromeRow"
import { PreviewDeviceToolbar } from "./PreviewDeviceToolbar"
import { PreviewEmptyState } from "./PreviewEmptyState"
import { PreviewNotices, PreviewStateView } from "./PreviewStates"
import { PreviewSlot } from "./PreviewSlot"

/** Below this pane width Forward hides and the device and float toggles move into More. */
const NARROW_PANE_PX = 360

/**
 * The web kind of the dock Preview tab: a chrome row, an optional device toolbar and notice
 * strips over a slot. The page itself is drawn by `PreviewSurfaceLayer` over the slot.
 */
export function WebPreviewPanel({ threadId, preview, active }: { threadId: ThreadId; preview: WebPreview | undefined; active: boolean }) {
  const session = usePreviewSession(threadId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [paneWidth, setPaneWidth] = useState(480)
  const [addressErrorState, setAddressError] = useState<{ message: string; index: number | undefined } | null>(null)
  const hasPage = !!preview && preview.entries.length > 0
  const floating = hasPage && preview.floating
  const device = hasPage && preview.viewport.mode === "device" ? preview.viewport : null

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])
  // The accent dot on the tab says an agent opened something; showing the tab clears it.
  useEffect(() => {
    if (active && preview?.unseen) useStore.getState().markPreviewSeen(threadId)
  }, [active, preview?.unseen, threadId])
  // An address error belongs to the entry it was typed over; opening or closing a page drops it.
  const addressError = addressErrorState && addressErrorState.index === preview?.index ? addressErrorState.message : null

  const showFolder = () => useStore.getState().set({ rightOpen: true, rightTab: "explorer" })

  const header = (
    <>
      <PreviewChromeRow threadId={threadId} preview={preview} session={session} active={active} narrow={paneWidth < NARROW_PANE_PX} onAddressError={(message) => setAddressError(message ? { message, index: preview?.index } : null)} />
      {device && <PreviewDeviceToolbar threadId={threadId} viewport={device} paneWidth={paneWidth} />}
      <PreviewNotices threadId={threadId} preview={preview} session={session} addressError={addressError} />
    </>
  )

  return (
    <div ref={rootRef} className="h-full min-h-0 w-full" data-preview-pane onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault()
        rootRef.current?.querySelector<HTMLButtonElement>('[data-preview-address] button[aria-label="Address"], [data-preview-address] input')?.click()
      }
    }}>
      <PreviewPanel kind="Web" header={header}>
        {!hasPage && !preview?.pending ? (
          <PreviewEmptyState threadId={threadId} active={active} />
        ) : floating ? (
          <DockEmpty
            icon={<PictureInPictureIcon className="size-4" />}
            title="Floating over the chat"
            body="The page keeps running in the mini player."
            action={<Button size="sm" variant="subtle" onClick={() => useStore.getState().setPreviewFloating(threadId, false)}>Return to panel</Button>}
          />
        ) : hasPage && preview ? (
          <PreviewSlot kind="dock" threadId={threadId} visible={active} className={cn("absolute inset-0", device && "bg-[color-mix(in_srgb,var(--color-text-foreground)_3%,var(--color-background-surface))]")}>
            {session.load.phase !== "ready" && session.load.phase !== "resolving" && session.load.phase !== "idle" || preview.pending ? (
              <PreviewStateView threadId={threadId} preview={preview} session={session} active={active} onShowFolder={showFolder} />
            ) : null}
          </PreviewSlot>
        ) : preview ? (
          <PreviewStateView threadId={threadId} preview={preview} session={session} active={active} onShowFolder={showFolder} />
        ) : null}
      </PreviewPanel>
    </div>
  )
}
