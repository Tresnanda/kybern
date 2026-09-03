// Chat markdown, styled by Synara's `.chat-markdown` rules (styles/synara.css).
// Code blocks get the `.chat-markdown-codeblock` chrome: language label,
// wrap toggle and copy action in the header, shiki-highlighted body.

import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { useTheme } from "@/components/theme-provider"
import { copyText } from "@/lib/hooks"
import { CheckIcon, CopyIcon, TextWrapIcon } from "@/lib/synara/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"

type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string
  loadLanguage: (lang: unknown) => Promise<void>
  getLoadedLanguages: () => string[]
}
let highlighterPromise: Promise<Highlighter> | null = null
const ALIASES: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash", py: "python", rs: "rust", yml: "yaml", md: "markdown", kt: "kotlin", "c++": "cpp" }

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes"),
      ])
      const hl = await createHighlighterCore({
        themes: [bundledThemes["github-dark-default"], bundledThemes["github-light-default"]],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })
      return hl as unknown as Highlighter
    })()
  }
  return highlighterPromise
}

async function ensureLang(hl: Highlighter, lang: string): Promise<boolean> {
  if (hl.getLoadedLanguages().includes(lang)) return true
  const { bundledLanguages } = await import("shiki/langs")
  const loader = (bundledLanguages as Record<string, unknown>)[lang]
  if (!loader) return false
  await hl.loadLanguage(loader)
  return true
}

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

/** Highlights `code` with shiki, or returns null when the language is unknown. */
export async function highlightToHtml(code: string, lang: string | null, dark: boolean): Promise<string | null> {
  if (!lang) return null
  const h = await getHighlighter()
  if (!(await ensureLang(h, lang))) return null
  return h.codeToHtml(code, { lang, theme: dark ? "github-dark-default" : "github-light-default" })
}

export function useIsDark(): boolean {
  const { theme } = useTheme()
  return theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const dark = useIsDark()
  const [html, setHtml] = useState<string | null>(null)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const name = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : null
  useEffect(() => {
    let live = true
    if (!name) return
    getHighlighter()
      .then(async (h) => {
        if (!(await ensureLang(h, name)) || !live) return
        setHtml(h.codeToHtml(code, { lang: name, theme: dark ? "github-dark-default" : "github-light-default" }))
      })
      .catch(() => setHtml(null))
    return () => {
      live = false
    }
  }, [code, name, dark])

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
            {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
          </button>
        </span>
      </div>
      <div className="chat-markdown-codeblock__body [&_pre]:!bg-transparent">
        {html && name ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (node && typeof node === "object" && "props" in node) return extractText((node as { props: { children?: ReactNode } }).props.children)
  return ""
}

export const Markdown = memo(function Markdown({
  text,
  className,
  variant = "assistant",
  style,
}: {
  text: string
  className?: string
  variant?: "assistant" | "user"
  style?: CSSProperties
}) {
  return (
    <div
      className={cn("chat-markdown selectable w-full min-w-0 text-sm leading-relaxed text-foreground", variant === "user" && "chat-markdown--user", className)}
      style={style}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children
            const props = (child as { props?: { className?: string; children?: ReactNode } } | null)?.props
            const lang = /language-([\w+-]+)/.exec(props?.className ?? "")?.[1]
            const code = extractText(props?.children).replace(/\n$/, "")
            return <CodeBlock code={code} lang={lang} />
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
