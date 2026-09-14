// Syntax parsing/tokenization lives off the renderer thread. Only one request is
// sent at a time by highlight.ts, so obsolete streams cannot build a worker backlog.
import type { HighlightJob } from "./highlightQueue"
import { createHighlightCache } from "./highlightCache"
type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string
  loadLanguage: (lang: unknown) => Promise<void>
  getLoadedLanguages: () => string[]
}
let highlighterPromise: Promise<Highlighter> | null = null
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
// Keep the source as the final map key instead of embedding it in a composite
// key. The cache implementation retains each source once while preserving the
// existing settled-output limits.
const cache = createHighlightCache()

async function highlight(job: HighlightJob): Promise<string | null> {
  const cached = cache.get(job.dark, job.lang, job.code)
  if (cached !== undefined) return cached
  const h = await getHighlighter()
  if (!(await ensureLang(h, job.lang))) return null
  const html = h.codeToHtml(job.code, { lang: job.lang, theme: job.dark ? "github-dark-default" : "github-light-default" })
  // Settled code only: don't retain every prefix of a live stream.
  if (job.cache) cache.set({ dark: job.dark, lang: job.lang, code: job.code, html })
  return html
}

self.onmessage = (event: MessageEvent<HighlightJob>) => {
  const job = event.data
  void highlight(job).then(
    (html) => self.postMessage({ id: job.id, html }),
    () => self.postMessage({ id: job.id, html: null }),
  )
}
