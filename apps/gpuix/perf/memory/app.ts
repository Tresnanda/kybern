// Full product plus read-only residency diagnostics and synthetic navigation.
import { heapStats } from 'bun:jsc'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
await import('../bench/app.ts')
const { getState } = await import('../../src/state.ts')
const { loadEarlier } = await import('../../src/transcript/store.ts')
const { openNote } = await import('../../src/notes/store.ts')
const { setDock } = await import('../../src/dock/store.ts')
const { openPreview, showPreview, closePreview, previewState } = await import('../../src/preview/store.ts')
const { renderMermaid } = await import('../../src/transcript/mermaid.ts')
type Native = { getMemoryStats?: () => unknown; getSyntaxDocumentStats?: () => unknown; scrollToItem: (id: number, index: number, offset?: number) => void; getAutomationTree: () => string }
const renderer = () => {
  const root = (globalThis as Record<string, unknown>).__benchFiberRoot as { containerInfo?: { nativeRenderer?: Native } } | undefined
  return root?.containerInfo?.nativeRenderer ?? ((globalThis as Record<string, unknown>).__gpuixRenderHost as { renderer: Native }).renderer
}
const bench = JSON.parse(readFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'bench-control.json'), 'utf8')).port
let diagramTimer: ReturnType<typeof setInterval> | undefined
const diagramCancel = new AbortController()
const diagrams = { requested: 0, completed: 0, failed: 0 }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, async fetch(req) {
  const body = await req.json() as { action: string; note?: string; index?: number; file?: string }
  if (body.action === 'older-all') {
    for (let page = 0; page < 150 && getState().open.nextBeforeSeq != null; page++) await loadEarlier()
  } else if (body.action === 'note') openNote(body.note!)
  else if (body.action === 'preview') { if (!(await openPreview(getState().selectedId!, body.file!))) throw Error('Preview did not open'); showPreview(getState().selectedId!) }
  else if (body.action === 'preview-close') closePreview(getState().selectedId!)
  else if (body.action === 'mermaid-start') {
    let index = 0
    const draw = () => {
      diagrams.requested++
      void renderMermaid(`flowchart LR\n A[Memory job ${index++}] --> B[Native image]`, true, diagramCancel.signal).then(image => { if (image) diagrams.completed++; else diagrams.failed++ })
    }
    draw(); diagramTimer = setInterval(draw, 3000)
  } else if (body.action === 'mermaid-stop') { clearInterval(diagramTimer); diagramTimer = undefined }
  else if (body.action === 'terminal') setDock(getState().selectedId, { open: true, instant: true, tabs: ['terminal'], tab: 'terminal', width: 760 })
  else if (body.action === 'jump') {
    const response = await fetch(`http://127.0.0.1:${bench}`, { method: 'POST', body: JSON.stringify({ action: 'scroll-state', target: 'transcript' }) })
    const target = await response.json() as { id: number }
    renderer().scrollToItem(target.id, body.index!, 0)
  }
  const s = getState(), preview = s.selectedId ? previewState(s.selectedId) : null
  return Response.json({ diagrams, preview: preview ? { phase: preview.load.phase, loading: preview.loading, entries: preview.entries.length } : null, heap: heapStats(), process: process.memoryUsage(), native: renderer().getMemoryStats?.() ?? null, syntax: renderer().getSyntaxDocumentStats?.() ?? null, blocks: s.open.blocks.length, nextBeforeSeq: s.open.nextBeforeSeq })
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'memory-control.json'), JSON.stringify({ port: server.port }))
process.stdin.on('end', () => { clearInterval(diagramTimer); diagramCancel.abort(); server.stop(true) })
