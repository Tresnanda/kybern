// Mermaid diagrams for the transcript (`lib/mermaid.ts`, `components/kybern/MermaidBlock.tsx`).
// The desktop renders SVG in a disposable iframe and shows it as an inert image. GPUIX has no
// web view in the transcript, so the same bundled Mermaid runs in one hidden, never-placed
// WKWebView (the embedded-preview companion) and the SVG it returns is drawn natively by GPUI's
// SVG renderer (resvg, system fonts) as an image: sharp at any scale, no bitmap. Same limits and config as the desktop: one job at a time, a
// 32 KiB source cap, a 512 KiB SVG cap, `securityLevel: strict`, no HTML labels, an 8-entry
// result cache, cancellation, and the renderer is released ~10 s after the last job.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webHost, type WebEvent } from '../native/webview.ts'

export type DiagramImage = { path: string; width: number; height: number }
const CODE_LIMIT = 32_768
const SVG_LIMIT = 512 * 1024
const IDLE_MS = 10_000
const JOB_MS = 15_000
const ID = 'mermaid-renderer'
const dir = path.join(tmpdir(), `kybern-gpuix-mermaid-${process.pid}`)

function bundlePath(): string | null {
  const candidates = [
    process.env.KYBERN_GPUIX_RESOURCES && path.join(process.env.KYBERN_GPUIX_RESOURCES, 'mermaid.min.js'),
    fileURLToPath(new URL('../../../desktop/node_modules/mermaid/dist/mermaid.min.js', import.meta.url)),
  ]
  return candidates.find((file): file is string => !!file && existsSync(file)) ?? null
}
/** The renderer is a hidden web document: without an embedded web view nothing is drawn and the fence keeps its source. */
export const mermaidAvailable = () => webHost.available && bundlePath() !== null

// Nothing in the renderer needs the network: Mermaid's strict mode is the first line, this CSP
// the second (the bundle and jobs arrive through evaluateJavaScript, which CSP does not gate).
const WRAPPER = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:"><body><script>
const send = message => window.webkit.messageHandlers.kybern.postMessage(message)
window.addEventListener('error', event => send({ kind: 'mermaid-error', message: String(event.message) }))
window.kybernBundle = () => send({ kind: 'mermaid-bundle', has: typeof window.mermaid })
/** Explicit pixel size from the viewBox (Mermaid emits width="100%"), so the native SVG renderer has an intrinsic size. */
function sized(svgText) {
  const el = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement
  const box = (el.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number)
  const w = box[2] || parseFloat(el.getAttribute('width')) || 600, h = box[3] || parseFloat(el.getAttribute('height')) || 400
  el.setAttribute('width', w); el.setAttribute('height', h); el.removeAttribute('style')
  return { svg: new XMLSerializer().serializeToString(el), width: w, height: h }
}
window.kybernRender = async job => {
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: job.dark ? 'dark' : 'default', fontFamily: 'system-ui, sans-serif',
      htmlLabels: false, maxTextSize: ${CODE_LIMIT}, maxEdges: 256, secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'suppressErrorRendering'] })
    send({ kind: 'mermaid-step', step: 'parse' })
    if (!(await mermaid.parse(job.code, { suppressErrors: true }))) return send({ kind: 'mermaid-result', id: job.id, ok: false })
    send({ kind: 'mermaid-step', step: 'render' })
    const { svg } = await mermaid.render('diagram-' + job.id, job.code)
    if (svg.length > ${SVG_LIMIT}) return send({ kind: 'mermaid-result', id: job.id, ok: false })
    send({ kind: 'mermaid-result', id: job.id, ok: true, ...sized(svg) })
  } catch (error) { send({ kind: 'mermaid-error', message: String(error && error.stack || error) }); send({ kind: 'mermaid-result', id: job.id, ok: false }) }
  document.body.replaceChildren()
}
send({ kind: 'mermaid-wrapper' })
</script>`

type Job = { id: number; code: string; dark: boolean; resolve: (image: DiagramImage | null) => void; signal: AbortSignal; key: string }
let queue: Job[] = []
let active: Job | undefined
let ready = false, created = false, stopListening: (() => void) | undefined
let deadline: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setTimeout> | undefined
let nextId = 1
const cache = new Map<string, DiagramImage | null>()

function release() {
  clearTimeout(deadline); clearTimeout(idle)
  if (created) { webHost.destroy(ID); created = false; ready = false }
  stopListening?.(); stopListening = undefined
  const failed = active; active = undefined
  failed?.resolve(null)
  for (const job of queue) job.resolve(null)
  queue = []
  for (const image of cache.values()) if (image) rmSync(image.path, { force: true })
  cache.clear()
  rmSync(dir, { recursive: true, force: true })
}
function remember(key: string, image: DiagramImage | null) {
  cache.delete(key); cache.set(key, image)
  while (cache.size > 8) { const [old, value] = cache.entries().next().value!; cache.delete(old); if (value) rmSync(value.path, { force: true }) }
}
function listen() {
  if (stopListening) return
  stopListening = webHost.subscribe((event: WebEvent) => {
    if (event.id !== ID) return
    if (process.env.KYBERN_MERMAID_DEBUG) console.error('[mermaid]', JSON.stringify(event).slice(0, 300))
    if (event.type === 'failed' || event.type === 'terminated') { release(); return }
    const data = event.data as { kind?: string; id?: number; ok?: boolean; svg?: string; width?: number; height?: number } | undefined
    if (event.type !== 'message' || !data) return
    if (data.kind === 'mermaid-wrapper') {
      const bundle = bundlePath()
      if (!bundle) { release(); return }
      webHost.post(ID, readFileSync(bundle, 'utf8'))
      webHost.post(ID, 'window.kybernBundle()')
      ready = true; pump()
      return
    }
    if (data.kind !== 'mermaid-result' || !active || data.id !== active.id) return
    const job = active; active = undefined; clearTimeout(deadline)
    let image: DiagramImage | null = null
    if (data.ok && data.svg) {
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${createHash('sha1').update(job.key).digest('hex').slice(0, 16)}.svg`)
      writeFileSync(file, data.svg)
      image = { path: file, width: data.width!, height: data.height! }
    }
    remember(job.key, image)
    job.resolve(job.signal.aborted ? null : image)
    pump()
  })
}
function pump() {
  clearTimeout(idle)
  if (active || !ready) return
  while (queue.length && queue[0]!.signal.aborted) queue.shift()!.resolve(null)
  const job = queue.shift()
  if (!job) { idle = setTimeout(release, IDLE_MS); return }
  active = job
  // Covers import and render failures too: no waiting consumer is left stranded.
  clearTimeout(deadline); deadline = setTimeout(release, JOB_MS)
  webHost.post(ID, `window.kybernRender(${JSON.stringify({ id: job.id, code: job.code, dark: job.dark })})`)
}

/** The diagram as an SVG file, or null when it cannot be drawn (invalid or too large source, no renderer, cancelled). */
export function renderMermaid(code: string, dark: boolean, signal: AbortSignal): Promise<DiagramImage | null> {
  if (signal.aborted || code.length > CODE_LIMIT || !mermaidAvailable()) return Promise.resolve(null)
  const key = `${dark}\0${code}`
  if (cache.has(key)) { const hit = cache.get(key)!; cache.delete(key); cache.set(key, hit); return Promise.resolve(hit && existsSync(hit.path) ? hit : null) }
  return new Promise(resolve => {
    queue.push({ id: nextId++, code, dark, signal, key, resolve })
    listen()
    if (!created) {
      created = true; webHost.createDocument(ID, WRAPPER)
    } else pump()
  })
}
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Best effort. */ } })
/** Drop cached diagrams and the renderer (a hidden window). */
export function releaseMermaid() { release() }
