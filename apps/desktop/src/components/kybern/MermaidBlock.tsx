import { memo, useEffect, useRef, useState } from "react"
import { CodeBlock, useIsDark } from "./CodeBlock"
import { renderMermaid } from "@/lib/mermaid"
import { useTranscriptRowState } from "@/lib/transcriptRowState"
import { useSlidingPill } from "@/lib/kit/slidingPill"
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { PanelExpandIcon } from "@/lib/kit/icons"

function DiagramView({ source, change }: { source: boolean; change: (source: boolean) => void }) {
  const [ref, pillStyle, ready] = useSlidingPill<HTMLDivElement>(source ? "source" : "preview")
  return <div ref={ref} className="t-tabs chat-diagram-view" role="group" aria-label="Diagram view">
    <span className="t-tabs-pill chat-diagram-view__pill" style={pillStyle} data-ready={ready} aria-hidden="true" />
    {[false, true].map(value => <button key={String(value)} type="button" aria-pressed={source === value} data-tab-active={source === value} aria-label={value ? "Show diagram source" : "Show diagram"} onClick={() => change(value)}>{value ? "Source" : "Preview"}</button>)}
  </div>
}

export const MermaidBlock = memo(function MermaidBlock({ code, live, stateKey }: { code: string; live: boolean; stateKey: string }) {
  const dark = useIsDark()
  const [source, setSource] = useTranscriptRowState(`${stateKey}:source`, false)
  const [expanded, setExpanded] = useState(false)
  const expandButton = useRef<HTMLButtonElement>(null)
  const [result, setResult] = useState<{ code: string; dark: boolean; url: string | null } | null>(null)
  useEffect(() => {
    if (live) return
    const abort = new AbortController()
    let url: string | undefined
    void renderMermaid(code, dark, abort.signal).then((svg) => {
      if (abort.signal.aborted) return
      url = svg ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : undefined
      setResult({ code, dark, url: url ?? null })
    })
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [code, dark, live])
  const current = !live && result?.code === code && result.dark === dark ? result : null
  return <div className="chat-mermaid" data-mermaid-state={live ? "streaming" : current ? current.url ? "ready" : "source" : "loading"}>
    <CodeBlock code={code} lang="mermaid" stateKey={stateKey}
      header={current?.url ? <DiagramView source={source} change={setSource} /> : <span className="chat-diagram-label">{!live && !current ? "Rendering diagram…" : "Mermaid source"}</span>}
      actions={current?.url && <button ref={expandButton} type="button" className="chat-diagram-expand chat-markdown-codeblock__action" onClick={() => setExpanded(true)} aria-label="Expand diagram" title="Expand diagram"><PanelExpandIcon className="size-3.5" /></button>}
      preview={current?.url && !source ? <div className="chat-diagram-canvas" tabIndex={0} role="region" aria-label="Mermaid diagram"><img src={current.url} alt="Mermaid diagram" /></div> : undefined}
    />
    {current && !current.url && <p className="chat-diagram-note" role="status">Preview unavailable. You can still copy the source.</p>}
    <Dialog open={expanded && !!current?.url} onOpenChange={setExpanded}>
      <DialogPopup finalFocus={() => expandButton.current} className="max-w-[min(90vw,1200px)] p-4" bottomStickOnMobile={false}>
        <DialogTitle className="pe-8 text-sm">Diagram</DialogTitle>
        <DialogDescription className="sr-only">Expanded diagram. Press Escape to close.</DialogDescription>
        {current?.url && <img src={current.url} alt="Mermaid diagram" className="mt-3 max-h-[75dvh] w-full rounded-lg object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10" />}
      </DialogPopup>
    </Dialog>
  </div>
})
