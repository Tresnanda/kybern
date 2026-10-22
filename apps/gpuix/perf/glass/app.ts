// Fixture entry for the round-2 glass captures: the unchanged full app (through `perf/pacing-app.ts`, as the bench runs
// it) on the scratch daemon of `perf/glass/seed.ts`, plus a localhost control server that puts the glass thread into the
// captured state. Harness-only; nothing here changes what the product renders.
//
//   KYBERN_GLASS_THREAD=<id>      the fixture thread (`open-fixture-thread`)
//   KYBERN_GLASS_BASELINE=<sha>   serve the app sources from that commit instead (round-1 Solid reference, `baseline.ts`)
//
// The control port is written to `$KYBERN_CLIENT_CONFIG_DIR/glass-control.json`. POST JSON `{action, …}`:
//   state                  selection, load and catalog readiness
//   open-fixture-thread    select the glass thread (or `thread`) on the thread page
//   scroll-up {px}         a native wheel event of `px` points over the transcript (the same event a trackpad delivers)
//   scroll-state           the transcript's scroll offset, its bounds and the bottom spacer's bounds
//   render-capture {path}  GPUI's own capture of the window (RGBA with the window's alpha) as a PNG
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const baseline = process.env.KYBERN_GLASS_BASELINE
if (baseline) {
  const { useBaseline } = await import('./baseline.ts')
  console.error(`[glass] baseline ${baseline}: ${useBaseline(baseline).length} sources served from git`)
}
await import('../pacing-app.ts')

type Renderer = {
  getAutomationTree: () => string
  getElementBounds: (id: number) => { x: number; y: number; width: number; height: number } | null
  getListScrollTop?: (id: number) => number[] | null
  getScrollOffset?: (id: number) => number[] | null
  simulateScrollWheel: (x: number, y: number, dx: number, dy: number, modifiers?: string) => void
  captureScreenshot?: (path: string) => void
}
const g = globalThis as Record<string, unknown>
const hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { onCommitFiberRoot: (...args: unknown[]) => void }
// Keep the root for the renderer; drop pacing-app's per-commit log line.
hook.onCommitFiberRoot = (...args) => { g.__glassFiberRoot = args[1] }
const renderer = () => (g.__glassFiberRoot as { containerInfo?: { nativeRenderer?: Renderer } } | undefined)?.containerInfo?.nativeRenderer

type Node = { id: number; testId?: string; children?: Node[] }
function find(r: Renderer, testId: string, prefix = false): Node | undefined {
  const tree = JSON.parse(r.getAutomationTree()) as Node | Node[]
  const stack = Array.isArray(tree) ? [...tree] : [tree]
  for (let visited = 0; stack.length && visited < 200_000; visited++) {
    const node = stack.pop()!
    if (prefix ? node.testId?.startsWith(testId) : node.testId === testId) return node
    stack.push(...(node.children ?? []))
  }
  return undefined
}
const offsetOf = (r: Renderer, id: number) => r.getListScrollTop?.(id) ?? r.getScrollOffset?.(id) ?? null

// Open the fixture's one file from first mount (`KYBERN_GLASS_EXPAND` = `file:<turn id>:<path>`, the row-state key of
// `EditedFileRow`), through the perf-harness hook `setRowStateDefault`: no click on a row that may be scrolled away.
const expand = process.env.KYBERN_GLASS_EXPAND
if (expand) (await import('../../src/transcript/store.ts')).setRowStateDefault((key) => key.endsWith(`:${expand}`) ? true : undefined)
const state = await import('../../src/state.ts')
const nav = await import('../../src/nav/store.ts')
const composer = await import('../../src/composer/store.ts')

const server = Bun.serve({ idleTimeout: 60, port: 0, hostname: '127.0.0.1', async fetch(req) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const body = await req.json() as { action: string; thread?: string; px?: number; path?: string }
  try {
    if (body.action === 'open-fixture-thread') {
      const id = body.thread ?? process.env.KYBERN_GLASS_THREAD
      if (!id) throw Error('No fixture thread: set KYBERN_GLASS_THREAD or pass `thread`')
      nav.setNav({ page: 'home', keyboardNav: true })
      await state.selectThread(id)
    }
    if (body.action === 'render-capture') {
      // The window's own pixels with their alpha (GPUI renders the current tree to a PNG; the in-scene frost blur is part of
      // it, the window-server desktop blur is not). `screencapture -l` cannot give this: with a custom blur radius the
      // window server composites the blurred desktop into the window image.
      const r = renderer()
      if (!r?.captureScreenshot) return Response.json({ error: 'no renderer capture' }, { status: 503 })
      r.captureScreenshot(body.path!)
      return Response.json({ path: body.path })
    }
    if (body.action === 'scroll-up' || body.action === 'scroll-state') {
      const r = renderer()
      if (!r) return Response.json({ error: 'renderer not captured yet' }, { status: 503 })
      const surface = find(r, 'transcript-surface'), list = find(r, 'transcript')
      if (!surface || !list) return Response.json({ error: 'no transcript on screen' }, { status: 409 })
      const before = offsetOf(r, list.id)
      if (body.action === 'scroll-up') {
        const b = r.getElementBounds(surface.id)!
        // Positive delta moves the content down: the reader goes up (as `app.mouse.wheel(…, 0, 8000)` goes to the top).
        r.simulateScrollWheel(b.x + b.width / 2, b.y + b.height * 0.4, 0, body.px ?? 600)
        await Bun.sleep(120)
      }
      const bottom = find(r, 'transcript-bottom:', true)
      return Response.json({ before, after: offsetOf(r, list.id), surface: r.getElementBounds(surface.id), bottomSpace: bottom ? r.getElementBounds(bottom.id) : null })
    }
    const s = state.getState(), data = composer.getData(), provider = data.target?.state.target.provider ?? s.open.thread?.provider
    const catalogKey = s.selectedId && provider ? `${s.selectedId}:${provider.kind}:${provider.instance}` : null
    const uiReady = data.settings !== null && (!s.selectedId || (data.target?.threadId === s.selectedId && data.catalog?.key === catalogKey && !data.catalogLoading))
    return Response.json({ selected: s.selectedId, loaded: s.open.loaded, blocks: s.open.blocks.length, uiReady, providers: data.providers.length, listsLoaded: s.listsLoaded })
  } catch (e) { return Response.json({ error: String(e) }, { status: 500 }) }
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'glass-control.json'), JSON.stringify({ port: server.port }))
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
// A forced host cancellation may bypass the runner's signal handlers.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 1000).unref()
export {}
