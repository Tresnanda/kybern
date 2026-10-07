import { memo, useEffect, useRef, useState } from "react"
import { Button } from "@/components/kit/button"
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { CodeIcon, DownloadIcon, PanelExpandIcon } from "@/lib/kit/icons"
import { openExternal, saveHtmlFile } from "@/lib/tauri"
import type { HtmlVisual, ThreadId } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { cn } from "@/lib/utils"
import { visualFileName, visualHeight, visualLink, visualThemeFragment, type VisualTheme } from "../../../../packages/kybern-client/src/visuals"

const THEME_VARIABLES = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "border", "input", "ring", "primary", "primary-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground", "warning", "warning-foreground", "success", "success-foreground", "info", "info-foreground", "radius"]
function currentTheme(): VisualTheme {
  const root = document.documentElement, computed = getComputedStyle(root)
  const variables: Record<string, string> = {}
  for (const name of THEME_VARIABLES) { const value = computed.getPropertyValue(`--${name}`).trim(); if (value) variables[`--${name}`] = value }
  variables["--font-sans"] = computed.getPropertyValue("--font-ui-family").trim() || "system-ui, sans-serif"
  variables["--font-mono"] = computed.getPropertyValue("--font-mono-family").trim() || "Menlo, monospace"
  const dark = root.classList.contains("dark")
  // Accent here is the brand color rather than Kybern's neutral hover fill.
  variables["--accent"] = computed.getPropertyValue("--color-text-accent").trim() || variables["--primary"]
  variables["--chart-1"] = variables["--accent"]
  const colors = dark ? ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"] : ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"]
  colors.forEach((color, i) => variables[`--chart-${i + 2}`] = color)
  variables["--code-background"] = computed.getPropertyValue("--color-background-code").trim() || variables["--card"]
  variables["--code-foreground"] = variables["--foreground"]
  return { appearance: dark ? "dark" : "light", variables }
}

/** Its URL and DOM remain stable across source toggles and streamed turn updates. */
export const VisualFrame = memo(function VisualFrame({ threadId, visual, active = true, expanded = false }: { threadId: ThreadId; visual: HtmlVisual; active?: boolean; expanded?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const post = useRef<() => void>(() => {})
  useEffect(() => {
    const runtime = activeRuntime(); let alive = true; let ticket: string | null = null
    void runtime.visualFrameUrl(threadId, visual.id).then(frame => {
      ticket = frame.ticket
      if (alive) { setUrl(frame.url + visualThemeFragment(currentTheme())); setError("") }
      else void runtime.rpc().call("threads.visuals.revoke", { thread_id: threadId, ticket }).catch(() => {})
    }).catch(error => { if (alive) setError(errorText(error)) })
    return () => { alive = false; if (ticket) void runtime.rpc().call("threads.visuals.revoke", { thread_id: threadId, ticket }).catch(() => {}) }
  }, [threadId, visual.id, attempt])
  useEffect(() => {
    const element = ref.current; if (!element || !url) return
    let intersects = false, frame = 0, pendingHeight: number | null = null, lastVisible: boolean | undefined
    const ancestors: HTMLElement[] = []; let ancestor: HTMLElement | null = element.parentElement
    while (ancestor) { ancestors.push(ancestor); ancestor = ancestor.parentElement }
    const send = () => {
      const visible = active && intersects && !document.hidden && !ancestors.some(parent => getComputedStyle(parent).opacity === "0")
      lastVisible = visible
      element.contentWindow?.postMessage({ kind: "kybern-visual-host", theme: currentTheme(), visible }, "*")
    }
    post.current = send
    const observer = new IntersectionObserver(entries => { intersects = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0); send() })
    observer.observe(element)
    const mutations = new MutationObserver(send)
    for (const parent of ancestors) mutations.observe(parent, { attributes: true, attributeFilter: ["class", "style", "data-theme-variant"] })
    const message = (event: MessageEvent) => {
      if (event.source !== element.contentWindow || event.origin !== "null" || !event.data || typeof event.data !== "object") return
      if (event.data.kind === "kybern-visual-size" && !expanded) {
        const height = visualHeight(event.data.height, visual.height)
        if (height === null) return
        pendingHeight = height
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (pendingHeight !== null) element.style.height = `${pendingHeight}px` })
      } else if (event.data.kind === "kybern-visual-link" && lastVisible && navigator.userActivation?.isActive) {
        const link = visualLink(event.data.url); if (link) void openExternal(link).catch(error => setError(errorText(error)))
      }
    }
    window.addEventListener("message", message); document.addEventListener("visibilitychange", send); send()
    return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener("message", message); document.removeEventListener("visibilitychange", send); cancelAnimationFrame(frame); post.current = () => {}; element.contentWindow?.postMessage({ kind: "kybern-visual-host", visible: false }, "*") }
  }, [url, active, expanded, visual.height])
  if (error) return <div role="alert" className="py-3 text-sm text-destructive"><p>{error}</p><Button variant="subtle" size="chip" className="mt-2" onClick={() => { setError(""); setAttempt(value => value + 1) }}>Retry visual</Button></div>
  return url ? <iframe ref={ref} title={visual.title} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => post.current()} className={cn("block w-full border-0 bg-transparent", expanded && "h-full min-h-0 flex-1")} style={expanded ? undefined : { height: visual.height }} data-visual-frame={visual.id} /> : <p className="py-3 text-sm text-muted-foreground" role="status">Loading visual…</p>
})

export const VisualReply = memo(function VisualReply({ threadId, visual }: { threadId: ThreadId; visual: HtmlVisual }) {
  const [open, setOpen] = useState(false), [sourceOpen, setSourceOpen] = useState(false)
  const [source, setSource] = useState<string | null>(null), [error, setError] = useState("")
  const [saving, setSaving] = useState(false), [truncated, setTruncated] = useState(false)
  useEffect(() => {
    if (!open || !sourceOpen || source !== null) return
    let alive = true
    void activeRuntime().rpc().call("threads.visuals.read", { thread_id: threadId, visual_id: visual.id }).then(result => { if (alive) { setTruncated(result.html.length > 256_000); setSource(result.html.slice(0, 256_000)) } }).catch(error => { if (alive) setError(errorText(error)) })
    return () => { alive = false }
  }, [open, sourceOpen, source, threadId, visual.id])
  const save = async () => {
    setSaving(true); setError("")
    try {
      const { html } = await activeRuntime().rpc().call("threads.visuals.read", { thread_id: threadId, visual_id: visual.id })
      await saveHtmlFile(visualFileName(visual.title), html)
    } catch (error) { setError(errorText(error)) } finally { setSaving(false) }
  }
  const close = () => { setOpen(false); setSourceOpen(false); setSource(null); setError(""); setTruncated(false) }
  return <div className="chat-paint-host min-w-0 space-y-2 py-2" data-visual-reply={visual.id}>
    <VisualFrame threadId={threadId} visual={visual} active={!open} />
    <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
      <Button variant="ghost" size="chip" onClick={() => setOpen(true)}><PanelExpandIcon className="size-3.5" />Expand visual</Button>
      <Button variant="ghost" size="chip" onClick={() => { setSourceOpen(true); setOpen(true) }}><CodeIcon className="size-3.5" />View source</Button>
      <Button variant="ghost" size="chip" disabled={saving} onClick={() => void save()}><DownloadIcon className="size-3.5" />{saving ? "Saving…" : "Save HTML"}</Button>
    </div>
    {!open && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Dialog open={open} onOpenChange={value => { if (!value) close() }}>
      <DialogPopup instant className="flex h-[min(880px,90dvh)] max-w-6xl flex-col gap-3 p-4">
        <DialogTitle className="pe-8 break-words">{visual.title}</DialogTitle>
        <DialogDescription className="sr-only">Interactive visual reply. Inspect the source or save a copy.</DialogDescription>
        <div className="flex flex-wrap gap-2">
          <Button size="chip" variant="subtle" onClick={() => setSourceOpen(value => !value)}>{sourceOpen ? "Show visual" : "View source"}</Button>
          <Button size="chip" variant="ghost" disabled={saving} onClick={() => void save()}><DownloadIcon className="size-3.5" />Save HTML</Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {open && <div className={cn("flex min-h-0 flex-1 flex-col", sourceOpen && "pointer-events-none opacity-0")} aria-hidden={sourceOpen} inert={sourceOpen}><VisualFrame threadId={threadId} visual={visual} active={!sourceOpen} expanded /></div>}
          {sourceOpen && <div className="absolute inset-0 flex min-h-0 flex-col gap-2">
            {truncated && <p className="text-xs text-muted-foreground">Source preview shows the first 256 KB. Save HTML for the complete document.</p>}
            {source === null ? <p className="text-sm text-muted-foreground" role="status">Loading source…</p> : <pre tabIndex={0} className="selectable min-h-0 flex-1 overflow-auto rounded-xl bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words" data-visual-source>{source}</pre>}
          </div>}
        </div>
      </DialogPopup>
    </Dialog>
  </div>
})
