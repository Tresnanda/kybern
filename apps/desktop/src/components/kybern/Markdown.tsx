import { ResponseImage } from "./ResponseImage"
import { localImageLink } from "@/lib/responseImages"
// Chat markdown, styled by the `.chat-markdown` rules (styles/kit.css).
// Code blocks get the `.chat-markdown-codeblock` chrome: language label,
// wrap toggle and copy action in the header, shiki-highlighted body.

import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { toJsxRuntime } from "hast-util-to-jsx-runtime"
import { jsx, jsxs } from "react/jsx-runtime"
import { createMarkdownParser, sameMarkdownNode, type MarkdownBlock, type ParsedMarkdown } from "@/lib/markdownParser"
import { cachedMarkdown, cacheMarkdown, nextMarkdownConsumer, parseMarkdown, releaseMarkdown } from "@/lib/markdown"

import { ChatFileLink } from "./ChatFileLink"
import { cn } from "@/lib/utils"
import { StreamWords } from "@/components/kybern/motion"
import { renderWithTokens, type InlineTokenValue } from "@/lib/inlineTokens"

import { CodeBlock } from "./CodeBlock"
import { MermaidBlock } from "./MermaidBlock"
export { CodeBlock, languageForPath, useIsDark } from "./CodeBlock"
export { highlightToHtml } from "@/lib/highlight"


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
  const key = `${stateKey}:code:${node?.position?.start.offset ?? 0}`
  return lang?.toLowerCase() === "mermaid"
    ? <MermaidBlock code={code} live={live} stateKey={key} />
    : <CodeBlock code={code} lang={lang} live={live} stateKey={key} />
}

// Stable component types preserve code-block state and highlighting across deltas.
const BASE_COMPONENTS: import("react-markdown").Components = {
  img: ({ src, alt }) => <ResponseImage source={typeof src === "string" ? src : ""} label={alt || "Agent image"} />,
  a: ({ href, children }) => href && localImageLink(href) ? <ResponseImage source={href} label={extractText(children) || "Image preview"} linkLabel={children} /> : <ChatFileLink href={href}>{children}</ChatFileLink>,
  pre: MarkdownCode,
  table: ({ children }) => <div className="chat-markdown-table" role="region" aria-label="Table" tabIndex={0}><table>{children}</table></div>,
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
  const [result, setResult] = useState<(ParsedMarkdown & { revision?: number }) | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const flight = useRef<{ source: string; abort: AbortController } | null>(null)
  useEffect(() => {
    let current = true
    const pending = flight.current
    if (pending) {
      if (text.startsWith(pending.source)) return
      flight.current = null
      pending.abort.abort()
    }
    if (immediate || result?.source === text || failed === text) {
      // An immediate parse can replace a different worker result while a
      // virtual row stays mounted. Drop a retained large tree in a microtask
      // so the cache hit remains synchronous without a render storm on the
      // usual short streaming updates.
      if (immediate && result && result.source !== text && (text.length > 1024 || result.source.length > 1024)) {
        queueMicrotask(() => { if (current) setResult(immediate) })
      }
      if (!live) {
        const parsed = immediate ?? result
        if (parsed?.source === text) cacheMarkdown(parsed)
      }
      return () => { current = false }
    }
    const job = { source: text, abort: new AbortController() }
    flight.current = job
    void parseMarkdown({ consumer, source: text, baseRevision: result?.revision ?? 0 }, job.abort.signal).then((reply) => {
      if (flight.current !== job) return
      flight.current = null
      if (!reply) { setFailed(text); setResult(null); return }
      const old = new Map(result?.blocks.map((block) => [block.key, block]))
      const blocks = reply.blocks.map((block) => {
        const existing = old.get(block.key)
        return existing && sameMarkdownNode(existing.node, block.node) ? existing : block
      })
      setResult({ source: text, revision: reply.revision, blocks: [...(result?.blocks.slice(0, reply.prefix) ?? []), ...blocks] })
    })
    return () => { current = false }
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
  tokens?: ReadonlyMap<string, InlineTokenValue>
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
