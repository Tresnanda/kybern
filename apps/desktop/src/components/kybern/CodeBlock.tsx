import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTheme } from "@/components/theme-context"
import { copyText } from "@/lib/hooks"
import { CheckIcon, CopyIcon, TextWrapIcon } from "@/lib/kit/icons"
import { IconSwap } from "./motion"
import { shouldHighlightSource, streamingHighlightInterval } from "@/lib/workload"
import { highlightToHtml } from "@/lib/highlight"
import { useTranscriptRowState } from "@/lib/transcriptRowState"

const ALIASES: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash", py: "python", rs: "rust", yml: "yaml", md: "markdown", kt: "kotlin", "c++": "cpp" }

/** Language id for a file path, or null when shiki has no grammar for it. */
export function languageForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path
  const lower = name.toLowerCase()
  if (lower === "dockerfile") return "dockerfile"
  if (lower === "makefile") return "makefile"
  const ext = lower.includes(".") ? lower.split(".").pop()! : ""
  const map: Record<string, string> = {
    ...ALIASES,
    tsx: "tsx",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    toml: "toml",
    yaml: "yaml",
    html: "html",
    css: "css",
    scss: "scss",
    go: "go",
    rb: "ruby",
    java: "java",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sql: "sql",
    xml: "xml",
    svg: "xml",
    lock: "yaml",
    txt: "",
  }
  const lang = ext in map ? map[ext]! : ext
  return lang ? lang : null
}

export function useIsDark(): boolean {
  const { theme } = useTheme()
  return theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
}

export const CodeBlock = memo(function CodeBlock({ code, lang, live = false, stateKey = "code", preview, actions }: { code: string; lang?: string; live?: boolean; stateKey?: string; preview?: ReactNode; actions?: ReactNode }) {
  const dark = useIsDark()
  const [highlight, setHighlight] = useState<{ code: string; name: string; dark: boolean; html: string } | null>(null)
  const markup = useMemo(() => highlight ? { __html: highlight.html } : null, [highlight])
  const highlightedAt = useRef(0)
  const inFlight = useRef<{ code: string; name: string; dark: boolean; abort: AbortController } | null>(null)
  const [wrap, setWrap] = useTranscriptRowState(stateKey, false)
  const [copied, setCopied] = useState(false)
  const name = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : null
  const highlightable = !!name && name !== "mermaid" && shouldHighlightSource(code)
  const currentHighlight = highlight && highlight.name === name && highlight.dark === dark &&
    (highlight.code === code || (live && code.startsWith(highlight.code)))
  useEffect(() => {
    const pending = inFlight.current
    if (pending) {
      // Let an in-progress prefix finish while more text arrives. Cancelling on
      // every token would starve highlighting throughout a continuous stream.
      if (live && pending.name === name && pending.dark === dark && code.startsWith(pending.code)) return
      inFlight.current = null
      pending.abort.abort()
    }
    if (!name || !highlightable || (highlight?.code === code && highlight.name === name && highlight.dark === dark)) return
    const wait = live ? Math.max(0, highlightedAt.current + streamingHighlightInterval(code.length) - performance.now()) : 0
    const timer = window.setTimeout(() => {
      const job = { code, name, dark, abort: new AbortController() }
      inFlight.current = job
      void highlightToHtml(code, name, dark, { signal: job.abort.signal, live })
        .then((html) => {
          if (inFlight.current !== job) return
          inFlight.current = null
          highlightedAt.current = performance.now()
          setHighlight(html ? { code, name, dark, html } : null)
        })
    }, wait)
    return () => window.clearTimeout(timer)
  }, [code, name, dark, live, highlightable, highlight])

  useEffect(() => () => {
    inFlight.current?.abort.abort()
    inFlight.current = null
  }, [])

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : undefined}>
      <div className="chat-markdown-codeblock__header">
        <span className="chat-markdown-codeblock__lang">{lang ?? "text"}</span>
        <span className="chat-markdown-codeblock__actions">
          {actions}
          {!preview && <button
            type="button"
            aria-label={wrap ? "Disable line wrap" : "Wrap lines"}
            data-active={wrap ? "true" : undefined}
            onClick={() => setWrap((v) => !v)}
            className="chat-markdown-codeblock__action inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
          >
            <TextWrapIcon className="size-3" />
          </button>}
          <button
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
            onClick={() => {
              void copyText(code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            }}
            className="chat-markdown-codeblock__action inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
          >
            <IconSwap active={copied ? "b" : "a"} a={<CopyIcon className="size-3" />} b={<CheckIcon className="size-3 text-success" />} />
          </button>
        </span>
      </div>
      <div className="chat-markdown-codeblock__body [&_pre]:!bg-transparent">
        {preview ?? (markup && highlightable && currentHighlight ? (
          <div dangerouslySetInnerHTML={markup} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        ))}
      </div>
    </div>
  )
})

