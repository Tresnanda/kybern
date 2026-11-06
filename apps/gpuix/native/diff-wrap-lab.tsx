// `<diff softWrap>` lab for diff-wrap-check.ts: the PR Changes view's diff (desktop table theme, syntax colours,
// cached layout) over a patch whose every 10th line is long. Keys drive it: w wrap, n narrow, j/t/s/h/m/r anchors,
// x maxLines, i inspect (JSON in `result`).
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useRef, useState } from 'react'
import { THEMES } from '../src/theme.ts'
import { desktopDiffTheme } from '../src/native/diff.ts'
import { PR_SCROLL_LAYOUT } from '../src/pulls/scroll-layout.ts'

const t = THEMES[process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark']
const theme = desktopDiffTheme(t, false, 13, { syntax: true })
const COUNT = 400
const long = (i: number) => `export const message${i} = "WRAPSTART${i} ${'a long wrapped string that keeps its syntax colours '.repeat(4)}WRAPEND${i}";`

/** Line `i` is row `i + 1` (row 0 is the hunk header): long additions at i % 10 == 3, long deletions at 6. */
function build() {
  const body: string[] = [], numbers: Record<number, { old: number | null; new: number | null }> = {}
  let oldNo = 1, newNo = 1
  for (let i = 0; i < COUNT; i++) {
    if (i % 10 === 3) { body.push(`+${long(i)}`); numbers[i] = { old: null, new: newNo++ } }
    else if (i % 10 === 6) { body.push(`-${long(i)}`); numbers[i] = { old: oldNo++, new: null } }
    else { body.push(` const short${i} = ${i};`); numbers[i] = { old: oldNo++, new: newNo++ } }
  }
  const patch = `diff --git a/src/wrap.ts b/src/wrap.ts\n--- a/src/wrap.ts\n+++ b/src/wrap.ts\n@@ -1,${oldNo - 1} +1,${newNo - 1} @@\n${body.join('\n')}\n`
  return { patch, numbers }
}
const { patch, numbers } = build()

function Lab() {
  const renderer = useGpuixRequired()
  const [wrap, setWrap] = useState(process.env.DIFF_WRAP !== '0'), [narrow, setNarrow] = useState(false)
  const [shown, setShown] = useState(true), [generation, setGeneration] = useState(0)
  const [maxLines, setMaxLines] = useState<number | undefined>(undefined)
  const [result, setResult] = useState(''), clicks = useRef<string[]>([]), more = useRef<string[]>([])
  const saved = useRef<number[] | null>(null)
  const id = (testId: string): number => {
    const tree = JSON.parse((renderer as any).getAutomationTree())
    const find = (node: any): number | undefined => node.testId === testId || node.props?.testId === testId ? node.id : node.children?.map(find).find((n: number | undefined) => n != null)
    const value = Array.isArray(tree) ? tree.map(find).find((n: number | undefined) => n != null) : find(tree)
    if (value == null) throw Error(`Missing ${testId}`)
    return value
  }
  const inspect = () => ({
    wrap, narrow, maxLines,
    top: shown ? renderer.getListScrollTop?.(id('diff')) : null,
    saved: saved.current,
    clicks: clicks.current.slice(-8), more: more.current.slice(-4),
    numbers: { 3: numbers[3], 6: numbers[6], 4: numbers[4] },
    highlights: (renderer.getPaintedHighlights?.() ?? []).map(h => ({ sub: h.sub, text: h.text.slice(h.start, h.end), rects: h.rects.map(r => ({ x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, width: Math.round(r.width * 100) / 100, height: r.height })) })),
    painted: (renderer.getPaintedText?.() ?? []).filter(text => text.startsWith('Show ')),
  })
  const action = (key: string) => {
    try {
      if (key === 'w') setWrap(w => !w)
      else if (key === 'n') setNarrow(n => !n)
      else if (key === 'j') renderer.scrollToItem?.(id('diff'), 124, 30.5)
      else if (key === 't') renderer.scrollToItem?.(id('diff'), 0, 0)
      else if (key === 's') saved.current = renderer.getListScrollTop?.(id('diff')) ?? null
      else if (key === 'h') setShown(false)
      else if (key === 'm') { setGeneration(n => n + 1); setShown(true) }
      else if (key === 'r') { if (!saved.current) throw Error('No saved anchor'); renderer.scrollToItem?.(id('diff'), saved.current[0]!, saved.current[1]!) }
      else if (key === 'x') { clicks.current = []; setMaxLines(40) }
      else if (key === 'i') setResult(JSON.stringify(inspect()))
    } catch (error) { setResult(String(error)) }
  }
  return <div testId="ready" onKeyDown={e => action(e.key ?? '')} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: 16, backgroundColor: t.surface }}>
    <div highlight={[{ query: 'WRAPSTART', caseSensitive: true }, { query: 'WRAPEND', caseSensitive: true }, { query: 'short', caseSensitive: true }, { query: 'export', caseSensitive: true }]} style={{ width: narrow ? 460 : 700, height: 560, flexShrink: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 8, overflow: 'hidden' }}>
      {shown && <diff key={generation} {...PR_SCROLL_LAYOUT} testId="diff" patch={patch} scroll softWrap={wrap} theme={theme} maxLines={maxLines}
        onShowMore={e => { more.current.push(String(e.value)); setMaxLines(n => (n ?? 0) + 40) }}
        onLineClick={e => { clicks.current.push(`old:${e.oldLine ?? '-'} new:${e.newLine ?? '-'}`) }}
        style={{ userSelect: 'text', flexGrow: 1, minHeight: 100, minWidth: 0 }} />}
    </div>
    {/* Keep `result` small: a huge wrapped text node stalls a software-rendered frame for seconds. */}
    <text testId="result" style={{ fontSize: 1, height: 4, color: t.text }}>{result}</text>
  </div>
}
render(<Lab />, { title: 'Diff soft wrap', width: 740, height: 640, focus: false })
