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
async function highlight(job: HighlightJob): Promise<string | null> {
  const h = await getHighlighter()
  if (!(await ensureLang(h, job.lang))) return null
  return h.codeToHtml(job.code, { lang: job.lang, theme: job.dark ? "github-dark-default" : "github-light-default" })
}

self.onmessage = (event: MessageEvent<HighlightJob>) => {
  const job = event.data
  void highlight(job).then(
    (html) => self.postMessage({ id: job.id, html }),
    () => self.postMessage({ id: job.id, html: null }),
  )
}
