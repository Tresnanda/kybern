import { memo, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { ScrollArea } from "@/components/kit/scroll-area"
import { Spinner } from "@/components/kybern/bits"
import { IconSwap } from "@/components/kybern/motion"
import { useIsDark } from "@/components/kybern/Markdown"
import { CodeIcon, DownloadIcon, ExternalLinkIcon, EyeOpenIcon, XIcon } from "@/lib/kit/icons"
import { highlightToHtml } from "@/lib/highlight"
import { openExternal, saveHtmlFile } from "@/lib/tauri"
import { shouldHighlightSource } from "@/lib/workload"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore, type DockPreview } from "@/state/store"
import { visualFileName, visualThemeFragment } from "../../../../../packages/kybern-client/src/visuals"

import { VisualFrame } from "../VisualReply"
import { currentTheme, restorePreviewFocus } from "../visualFrameSupport"
import { PreviewAction, PreviewActionGroup, PreviewPanel, PreviewToggle } from "./PreviewPanel"

const SOURCE_PREVIEW_BYTES = 256_000

/** The dock Preview tab: whichever preview the selected thread holds, or an empty state. */
export const DockPreviewPane = memo(function DockPreviewPane({ threadId, active }: { threadId: ThreadId | null; active: boolean }) {
  const preview = useStore((s) => (threadId ? s.previews[threadId] : undefined))
  if (!threadId || !preview) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">Open a visual reply in this thread to preview it here.</div>
  }
  // One preview per thread: switching to another visual replaces the document.
  return <VisualPreviewPanel key={`${threadId}:${preview.visual.id}`} threadId={threadId} preview={preview} active={active} />
})

function VisualPreviewPanel({ threadId, preview, active }: { threadId: ThreadId; preview: Extract<DockPreview, { kind: "visual" }>; active: boolean }) {
  const { visual, mode } = preview
  const { id: visualId, title } = visual
  const dark = useIsDark()
  const [saving, setSaving] = useState(false)
  const [source, setSource] = useState<{ text: string; truncated: boolean } | null>(null), [sourceError, setSourceError] = useState("")
  const [highlight, setHighlight] = useState<{ text: string; dark: boolean; html: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // In the overlay dock the chat is inert, so move focus into the panel when it opens.
  useEffect(() => {
    const root = rootRef.current
    if (active && root?.closest("[data-overlay]") && !root.contains(document.activeElement)) root.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true })
  }, [active])

  // Source is fetched once, the first time it is shown, and dropped with the panel.
  useEffect(() => {
    if (mode !== "source" || source) return
    let alive = true
    void activeRuntime().rpc().call("threads.visuals.read", { thread_id: threadId, visual_id: visualId, max_bytes: SOURCE_PREVIEW_BYTES })
      .then((result) => { if (alive) setSource({ text: result.html.slice(0, SOURCE_PREVIEW_BYTES), truncated: result.truncated ?? result.html.length > SOURCE_PREVIEW_BYTES }) })
      .catch((failure) => { if (alive) setSourceError(errorText(failure)) })
    return () => { alive = false }
  }, [mode, source, threadId, visualId])
  useEffect(() => {
    if (!source || !shouldHighlightSource(source.text)) return
    const abort = new AbortController(), text = source.text
    highlightToHtml(text, "html", dark, { signal: abort.signal }).then((html) => { if (!abort.signal.aborted && html) setHighlight({ text, dark, html }) }).catch(() => {})
    return () => abort.abort()
  }, [source, dark])

  const highlighted = source && highlight?.text === source.text && highlight.dark === dark ? highlight.html : null
  const showSource = mode === "source"
  const save = async () => {
    setSaving(true)
    try {
      const { html } = await activeRuntime().rpc().call("threads.visuals.read", { thread_id: threadId, visual_id: visualId })
      await saveHtmlFile(visualFileName(title), html)
    } catch (failure) { toast.error("Unable to save HTML", { description: errorText(failure) }) } finally { setSaving(false) }
  }
  const openInBrowser = async () => {
    try {
      const frame = await activeRuntime().visualFrameUrl(threadId, visualId)
      await openExternal(frame.url + visualThemeFragment(currentTheme()))
    } catch (failure) { toast.error("Unable to open in browser", { description: errorText(failure) }) }
  }
  const close = () => {
    useStore.getState().closePreview(threadId)
    requestAnimationFrame(() => { restorePreviewFocus() })
  }

  return (
    <div ref={rootRef} className="h-full min-h-0 w-full">
      <PreviewPanel
        kind="Visual"
        title={title}
        actions={<>
          <PreviewActionGroup divider={false}>
            <PreviewToggle label={showSource ? "Show rendered page" : "Show HTML source"} pressed={showSource} onPressedChange={(pressed) => useStore.getState().setPreviewMode(threadId, pressed ? "source" : "rendered")}>
              <IconSwap active={showSource ? "b" : "a"} className="size-3.5" a={<CodeIcon className="size-3.5" />} b={<EyeOpenIcon className="size-3.5" />} />
            </PreviewToggle>
          </PreviewActionGroup>
          <PreviewActionGroup>
            <PreviewAction label="Open in browser" onClick={() => void openInBrowser()}><ExternalLinkIcon className="size-3.5" /></PreviewAction>
            <PreviewAction label="Save HTML" disabled={saving} onClick={() => void save()}>{saving ? <Spinner size={14} /> : <DownloadIcon className="size-3.5" />}</PreviewAction>
          </PreviewActionGroup>
          <PreviewActionGroup>
            <PreviewAction label="Close preview" onClick={close}><XIcon className="size-3.5" /></PreviewAction>
          </PreviewActionGroup>
        </>}
      >
        {/* Both layers stay mounted so switching modes keeps the same document; the hidden one is inert. */}
        <div className="t-pane absolute inset-0" data-active={!showSource} inert={showSource} aria-hidden={showSource} style={showSource ? { pointerEvents: "none" } : undefined}>
          <ScrollArea className="h-full">
            <VisualFrame threadId={threadId} visual={visual} mode="panel" active={active && !showSource} />
          </ScrollArea>
        </div>
        <div className="t-pane absolute inset-0" data-active={showSource} inert={!showSource} aria-hidden={!showSource} style={!showSource ? { pointerEvents: "none" } : undefined}>
          <ScrollArea className="h-full">
            {source?.truncated && <p className="chat-surface-divider px-4 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">Showing the first 256 KB. Save HTML for the full page.</p>}
            {sourceError ? <p className="px-4 py-3 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive/85">{sourceError}</p>
              : !source ? <p className="px-4 py-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground" role="status">Loading source…</p>
              : <div tabIndex={0} data-visual-source data-highlighted={highlighted ? "true" : undefined} className={cn("visual-source selectable")}>
                {highlighted ? <div dangerouslySetInnerHTML={{ __html: highlighted }} /> : <pre>{source.text}</pre>}
              </div>}
          </ScrollArea>
        </div>
      </PreviewPanel>
    </div>
  )
}
