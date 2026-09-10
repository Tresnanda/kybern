import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { toast } from "sonner"
import { chatLink } from "../../../../../packages/kybern-client/src/chatLinks"
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { Button } from "@/components/kit/button"
import { ImageThreadContext } from "@/lib/imageThread"
import { ChatFileBaseContext } from "@/lib/chatFileContext"
import { copyText } from "@/lib/hooks"
import { openExternal } from "@/lib/tauri"
import { activeRuntime, errorText } from "@/state/rpc"
import type { FilesReadResult } from "@/protocol/types"
import { CodeBlock, languageForPath, Markdown } from "./Markdown"

export function ChatFileLink({ href, children }: { href?: string; children?: ReactNode }) {
  const threadId = useContext(ImageThreadContext)
  const basePath = useContext(ChatFileBaseContext)
  const [open, setOpen] = useState(false)
  const link = useRef<HTMLAnchorElement>(null)
  const target = chatLink(href ?? "", basePath)
  return <>
    <a ref={link} href={href} className="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline [overflow-wrap:anywhere]"
      onClick={(event) => {
        event.preventDefault()
        if (target.kind === "external") void openExternal(target.url).catch((error) => toast.error("Unable to open link", { description: errorText(error) }))
        else if (target.kind === "file" && threadId) setOpen(true)
        else if (target.kind === "anchor") document.getElementById(target.id)?.scrollIntoView({ block: "nearest" })
        else toast.error(target.kind === "file" ? "Open this file from its conversation." : "This link cannot be opened.")
      }}>{children}</a>
    {open && threadId && target.kind === "file" && <ChatFilePreview key={target.path} threadId={threadId} path={target.path} line={target.line} returnFocus={link} onClose={() => setOpen(false)} />}
  </>
}

function ChatFilePreview({ threadId, path, line, returnFocus, onClose }: { threadId: string; path: string; line?: number; returnFocus: RefObject<HTMLAnchorElement | null>; onClose: () => void }) {
  const [file, setFile] = useState<FilesReadResult | null>(null)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const [raw, setRaw] = useState(!!line)
  const body = useRef<HTMLDivElement>(null)
  const markdown = /\.(md|mdx|markdown)$/i.test(path)
  useEffect(() => {
    let alive = true
    void (async () => activeRuntime().rpc().call("threads.files.read", { thread_id: threadId, path, max_bytes: 128000 }))().then((result) => {
      if (alive) setFile(result)
    }).catch((error) => {
      if (alive) setError((error as { code?: number }).code === -32601
        ? "Update Kybern on the connected computer to open chat file links."
        : errorText(error))
    })
    return () => { alive = false }
  }, [threadId, path, retry])
  useEffect(() => {
    const container = body.current
    if (!container || !file || !line || (markdown && !raw)) return
    const reveal = () => {
      const row = container.querySelectorAll<HTMLElement>("code > .line")[line - 1]
      if (!row) return
      row.style.backgroundColor = "var(--color-background-button-secondary)"
      container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - 32
      observer.disconnect()
    }
    const observer = new MutationObserver(reveal)
    observer.observe(container, { childList: true, subtree: true })
    reveal()
    return () => observer.disconnect()
  }, [file, line, markdown, raw])
  return <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
    <DialogPopup finalFocus={() => returnFocus.current} className="h-[min(800px,85dvh)] max-w-4xl" bottomStickOnMobile={false}>
      <DialogHeader className="shrink-0 pe-10">
        <DialogTitle className="break-words">{path.split(/[\\/]/).at(-1) || "File"}</DialogTitle>
        <DialogDescription className="break-words">{path}{line ? ` · Line ${line}` : ""}</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        {markdown && <Button size="sm" variant="subtle" onClick={() => setRaw(!raw)}>{raw ? "Show preview" : "Show source"}</Button>}
        <Button size="sm" variant="ghost" disabled={!file || file.binary} onClick={() => void copyText(file?.content ?? "")}>Copy contents</Button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {error ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p>{error}</p><Button variant="subtle" size="sm" onClick={() => { setError(""); setFile(null); setRetry(retry + 1) }}>Retry</Button></div>
          : !file ? <p role="status" className="text-sm text-muted-foreground">Opening file…</p>
          : file.binary ? <p className="text-sm text-muted-foreground">This file cannot be displayed as text.</p>
          : <ChatFileBaseContext value={path}>{markdown && !raw ? <Markdown text={file.content} /> : <CodeBlock code={file.content} lang={languageForPath(path) ?? undefined} />}</ChatFileBaseContext>}
        {file?.truncated && <p className="mt-3 text-xs text-muted-foreground">Showing the first 128 KB.</p>}
      </div>
    </DialogPopup>
  </Dialog>
}
