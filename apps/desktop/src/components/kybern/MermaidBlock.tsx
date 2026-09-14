import { memo, useEffect, useState } from "react"
import { CodeBlock, useIsDark } from "./CodeBlock"
import { renderMermaid } from "@/lib/mermaid"
import { useTranscriptRowState } from "@/lib/transcriptRowState"

export const MermaidBlock = memo(function MermaidBlock({ code, live, stateKey }: { code: string; live: boolean; stateKey: string }) {
  const dark = useIsDark()
  const [source, setSource] = useTranscriptRowState(`${stateKey}:source`, false)
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
  return <div data-mermaid-state={live ? "streaming" : current ? current.url ? "ready" : "source" : "loading"}>
    <CodeBlock code={code} lang="mermaid" stateKey={stateKey}
      actions={current?.url && <button type="button" className="chat-markdown-codeblock__action px-2 text-xs" onClick={() => setSource(!source)} aria-label={source ? "Show diagram" : "Show diagram source"}>{source ? "Diagram" : "Source"}</button>}
      preview={current?.url && !source ? <div className="overflow-auto p-4" tabIndex={0} role="region" aria-label="Mermaid diagram"><img className="mx-auto max-w-full" src={current.url} alt="Mermaid diagram; use Source to read or copy its definition" /></div> : undefined}
    />
    {current && !current.url && <p className="mt-1 text-xs text-muted-foreground" role="status">Diagram unavailable. The source is shown above.</p>}
  </div>
})
