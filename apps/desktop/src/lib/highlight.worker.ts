// Syntax parsing/tokenization lives off the renderer thread. Only one request is
// sent at a time by highlight.ts, so obsolete streams cannot build a worker backlog.
import type { HighlightJob } from "./highlightQueue"
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


const cache = new Map<string, string>()
let cacheBytes = 0
const MAX_CACHE_BYTES = 4 * 1024 * 1024
const MAX_CACHE_ENTRIES = 24

async function highlight(job: HighlightJob): Promise<string | null> {
  const key = `${job.dark ? "dark" : "light"}\0${job.lang}\0${job.code}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const h = await getHighlighter()
  if (!(await ensureLang(h, job.lang))) return null
  const html = h.codeToHtml(job.code, { lang: job.lang, theme: job.dark ? "github-dark-default" : "github-light-default" })
  const bytes = (key.length + html.length) * 2
  // Settled code only: don't retain every prefix of a live stream.
  if (job.cache && bytes <= MAX_CACHE_BYTES) {
    while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = cache.entries().next().value
      if (!oldest) break
      cache.delete(oldest[0])
      cacheBytes -= (oldest[0].length + oldest[1].length) * 2
    }
    cache.set(key, html)
    cacheBytes += bytes
  }
  return html
}

self.onmessage = (event: MessageEvent<HighlightJob>) => {
  const job = event.data
  void highlight(job).then(
    (html) => self.postMessage({ id: job.id, html }),
    () => self.postMessage({ id: job.id, html: null }),
  )
}
