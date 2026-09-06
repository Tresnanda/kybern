import { ResponseImage } from "./ResponseImage"
// Chat markdown, styled by the `.chat-markdown` rules (styles/kit.css).
// Code blocks get the `.chat-markdown-codeblock` chrome: language label,
// wrap toggle and copy action in the header, shiki-highlighted body.

import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { toJsxRuntime } from "hast-util-to-jsx-runtime"
import { jsx, jsxs } from "react/jsx-runtime"
import { createMarkdownParser, type MarkdownBlock, type ParsedMarkdown } from "@/lib/markdownParser"
import { cachedMarkdown, cacheMarkdown, nextMarkdownConsumer, parseMarkdown, releaseMarkdown } from "@/lib/markdown"

import { useTheme } from "@/components/theme-context"
import { copyText } from "@/lib/hooks"
import { CheckIcon, CopyIcon, TextWrapIcon } from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { IconSwap, StreamWords } from "@/components/kybern/motion"
import type { InlineTokenKind } from "@/components/kybern/InlineToken"
import { renderWithTokens } from "@/lib/inlineTokens"
import { shouldHighlightSource, streamingHighlightInterval } from "@/lib/workload"

import { highlightToHtml } from "@/lib/highlight"
import { useTranscriptRowState } from "@/lib/transcriptRowState"
export { highlightToHtml } from "@/lib/highlight"

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

export const CodeBlock = memo(function CodeBlock({ code, lang, live = false, stateKey = "code" }: { code: string; lang?: string; live?: boolean; stateKey?: string }) {
  const dark = useIsDark()
  const [highlight, setHighlight] = useState<{ code: string; name: string; dark: boolean; html: string } | null>(null)
  const markup = useMemo(() => highlight ? { __html: highlight.html } : null, [highlight])
  const highlightedAt = useRef(0)
  const inFlight = useRef<{ code: string; name: string; dark: boolean; abort: AbortController } | null>(null)
  const [wrap, setWrap] = useTranscriptRowState(stateKey, false)
  const [copied, setCopied] = useState(false)
  const name = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : null
  const highlightable = !!name && shouldHighlightSource(code)
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
          <button
            type="button"
            aria-label={wrap ? "Disable line wrap" : "Wrap lines"}
            data-active={wrap ? "true" : undefined}
            onClick={() => setWrap((v) => !v)}
            className="chat-markdown-codeblock__action inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
          >
            <TextWrapIcon className="size-3" />
          </button>
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
        {markup && highlightable && currentHighlight ? (
          <div dangerouslySetInnerHTML={markup} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
})

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (node && typeof node === "object" && "props" in node) return extractText((node as { props: { children?: ReactNode } }).props.children)
  return ""
}

/** Maps string children through `transform`; element children pass through untouched. */
function mapText(children: ReactNode, transform: (text: string, key: number) => ReactNode): ReactNode {
  if (typeof children === "string") return transform(children, 0)
  if (Array.isArray(children)) return children.map((child, i) => (typeof child === "string" ? transform(child, i) : child))
  return children
}

type TextTransform = (text: string, key: number) => ReactNode

/** Element overrides that run every text run through `transform` (streaming words, inline tokens). */
function textComponents(transform: TextTransform) {
  const wrap = (Tag: "p" | "li" | "strong" | "em" | "h1" | "h2" | "h3") =>
    function Text({ children }: { children?: ReactNode }) {
      return <Tag>{mapText(children, transform)}</Tag>
    }
  return { p: wrap("p"), li: wrap("li"), strong: wrap("strong"), em: wrap("em"), h1: wrap("h1"), h2: wrap("h2"), h3: wrap("h3") }
}

const streamTransform: TextTransform = (text, key) => <StreamWords key={key} text={text} />
const LIVE_TEXT_COMPONENTS = textComponents(streamTransform)

const MarkdownLiveContext = createContext(false)
const MarkdownStateContext = createContext("markdown")

function MarkdownCode({ children, node }: { children?: ReactNode; node?: { position?: { start: { offset?: number } } } }) {
  const live = useContext(MarkdownLiveContext)
  const stateKey = useContext(MarkdownStateContext)
  const child = Array.isArray(children) ? children[0] : children
  const props = (child as { props?: { className?: string; children?: ReactNode } } | null)?.props
  const lang = /language-([\w+-]+)/.exec(props?.className ?? "")?.[1]
  const code = extractText(props?.children).replace(/\n$/, "")
  return <CodeBlock code={code} lang={lang} live={live} stateKey={`${stateKey}:code:${node?.position?.start.offset ?? 0}`} />
}

// Stable component types preserve code-block state and highlighting across deltas.
const BASE_COMPONENTS: import("react-markdown").Components = {
  img: ({ src, alt }) => <ResponseImage source={typeof src === "string" ? src : ""} label={alt || "Agent image"} />,
  a: ({ href, children }) => (
    <a
      href={href}
      className="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline"
      onClick={(e) => {
        e.preventDefault()
        if (href) void openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  pre: MarkdownCode,
}

const LIVE_COMPONENTS = { ...LIVE_TEXT_COMPONENTS, ...BASE_COMPONENTS }
const ParsedBlock = memo(function ParsedBlock({ block, components, live }: { block: MarkdownBlock; components: import("react-markdown").Components; live: boolean }) {
  return <MarkdownLiveContext value={live}>{toJsxRuntime({ type: "root", children: [block.node] }, {
    Fragment, jsx, jsxs, components, ignoreInvalidStyle: true, passKeys: true, passNode: true,
  })}</MarkdownLiveContext>
})

function useParsedMarkdown(text: string, live: boolean) {
  const [consumer] = useState(nextMarkdownConsumer)
  const [parser] = useState(createMarkdownParser)
  const immediate = useMemo(() => text.length <= 1024 ? parser.parse(text) : cachedMarkdown(text), [text, parser])
  const [result, setResult] = useState<(ParsedMarkdown & { revision: number }) | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const flight = useRef<{ source: string; abort: AbortController } | null>(null)
  useEffect(() => {
    const pending = flight.current
    if (pending) {
      if (text.startsWith(pending.source)) return
      flight.current = null
      pending.abort.abort()
    }
    if (immediate || result?.source === text || failed === text) {
      if (!live) {
        const parsed = immediate ?? result
        if (parsed?.source === text) cacheMarkdown(parsed)
      }
      return
    }
    const job = { source: text, abort: new AbortController() }
    flight.current = job
    void parseMarkdown({ consumer, source: text, baseRevision: result?.revision ?? 0 }, job.abort.signal).then((reply) => {
      if (flight.current !== job) return
      flight.current = null
      if (!reply) { setFailed(text); return }
      const old = new Map(result?.blocks.map((block) => [block.key, block]))
      const blocks = reply.blocks.map((block) => old.get(block.key)?.signature === block.signature ? old.get(block.key)! : block)
      setResult({ source: text, revision: reply.revision, blocks: [...(result?.blocks.slice(0, reply.prefix) ?? []), ...blocks] })
    })
  }, [consumer, text, live, immediate, result, failed])
  useEffect(() => () => {
    flight.current?.abort.abort()
    flight.current = null
    releaseMarkdown(consumer)
  }, [consumer])
  // Keep the last parsed tree during a worker update, including edits. Replacing
  // it with a temporary text node would discard selections and code-block state.
  return immediate ?? (failed !== text ? result : null)
}

export const Markdown = memo(function Markdown({
  text,
  className,
  variant = "assistant",
  style,
  live = false,
  tokens,
}: {
  text: string
  className?: string
  variant?: "assistant" | "user"
  style?: CSSProperties
  /** While streaming, each newly arrived word resolves through a short blur. */
  live?: boolean
  /** Literal tokens ("$skill", "@path") to render as inline chips wherever they appear in text. */
  tokens?: ReadonlyMap<string, InlineTokenKind>
}) {
  const tokenComponents = useMemo(
    () => (tokens && tokens.size > 0 ? textComponents((text, key) => <Fragment key={key}>{renderWithTokens(text, tokens)}</Fragment>) : null),
    [tokens],
  )
  const parsed = useParsedMarkdown(text, live)
  const components = useMemo(() => tokenComponents ? { ...tokenComponents, ...BASE_COMPONENTS } : BASE_COMPONENTS, [tokenComponents])
  return (
    <div
      className={cn("chat-markdown selectable w-full min-w-0 text-sm leading-relaxed text-foreground", variant === "user" && "chat-markdown--user", className)}
      style={style}
    >
      <MarkdownStateContext value={variant}>
        {parsed ? parsed.blocks.map((block, index) => {
          const active = live && index === parsed.blocks.length - 1
          return <ParsedBlock key={block.key} block={block} live={active} components={active ? LIVE_COMPONENTS : components} />
        }) : <div className="whitespace-pre-wrap break-words">{text}</div>}
      </MarkdownStateContext>
    </div>
  )
})
