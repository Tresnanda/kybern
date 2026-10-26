// Live visual documents (ADE-69). A visual rests as a picture; clicking it makes one WK document live in its place.
// The document belongs to this module, not to a component, so "Open in a tab" and "Full screen" move the same document
// (owner `inline` → `tab` or `modal`) with its state, and a row the virtualiser unmounts does not reload it. At most
// MAX_DOCS documents exist, live or warm: a warm one is hidden with its state for WARM_MS, then destroyed. Opening a
// third retires the least recently used one: its owner first turns it back into a picture (`retire`), then it is destroyed.
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { visualHeight, visualLink, visualThemeFragment, type VisualTheme } from '../../../../packages/kybern-client/src/visuals.ts'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { launchBrowser } from '../preview/browser.ts'
import { webHost, type WebEvent } from '../native/webview.ts'
import { VISUAL_NO_WEB_VIEW } from './visualFallback.ts'

export const MAX_DOCS = 2
const WARM_MS = 60_000
/** How long a retiring owner may take to freeze its document before it is destroyed anyway. */
const RETIRE_MS = 600

export type DocOwner = 'inline' | 'tab' | 'modal'
export type DocMessage =
  | { kind: 'ready'; height: number | null }
  | { kind: 'size'; height: number }
  | { kind: 'draft'; value: unknown; label?: string }
  | { kind: 'submit' }
  | { kind: 'escape' }
  | { kind: 'hover'; over: boolean }
  | { kind: 'outsidePress'; x: number; y: number }
  | { kind: 'snapshot'; token: number; path: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'retire' }

interface Doc {
  id: string
  threadId: string
  visualId: string
  generation: number
  ticket?: string
  ready: boolean
  error: string
  owner: DocOwner | null
  usedAt: number
  /** Leaving to make room; its owner is turning it back into a picture. */
  retiring?: boolean
  warm?: ReturnType<typeof setTimeout>
  listeners: Set<(message: DocMessage) => void>
  theme: VisualTheme
}

const docs = new Map<string, Doc>()
const watchers = new Set<() => void>()
let version = 0
const changed = () => { version++; for (const watch of watchers) watch() }

export const docId = (threadId: string, visualId: string) => `visual:${threadId}:${visualId}`
export function subscribeDocs(watch: () => void) { watchers.add(watch); return () => { watchers.delete(watch) } }
export const docsVersion = () => version
export function docState(id: string): { owner: DocOwner | null; ready: boolean; error: string } | null {
  const doc = docs.get(id)
  return doc ? { owner: doc.owner, ready: doc.ready, error: doc.error } : null
}
/** Documents alive now (live and warm). The RAM check reads it. */
export const liveDocCount = () => docs.size

let routed = false
function route() {
  if (routed) return
  routed = true
  webHost.subscribe((event: WebEvent) => {
    const doc = docs.get(event.id)
    if (!doc || (event.generation !== undefined && event.generation !== doc.generation)) return
    const tell = (message: DocMessage) => { for (const listener of doc.listeners) listener(message) }
    // Placed but invisible until it reports its size: an unplaced web view runs no frames, so it could not measure itself.
    if (event.type === 'created' && !doc.ready) webHost.present(doc.id, { opacity: 0 })
    if (event.type === 'created' || event.type === 'loaded') { webHost.theme(doc.id, doc.theme); return }
    if (event.type === 'failed' || event.type === 'terminated') { doc.error = event.message ?? 'The page stopped responding. Reload to open it again.'; changed(); tell({ kind: 'error', message: doc.error }); return }
    if (event.type === 'outsidePress' && event.x !== undefined && event.y !== undefined) { tell({ kind: 'outsidePress', x: event.x, y: event.y }); return }
    if (event.type === 'snapshot') { tell({ kind: 'snapshot', token: event.token ?? 0, path: event.ok && event.path ? event.path : null }); return }
    if (event.type !== 'message' || !event.data) return
    const data = event.data
    switch (data.kind) {
      case 'kybern-visual-size': {
        const height = visualHeight(data.height)
        if (height === null) return
        if (!doc.ready) { doc.ready = true; doc.error = ''; changed(); tell({ kind: 'ready', height }) } else tell({ kind: 'size', height })
        return
      }
      case 'kybern-visual-ready':
        // A page that never posts a size (an error before its first layout) still shows after a second.
        setTimeout(() => { if (docs.get(doc.id) === doc && !doc.ready) { doc.ready = true; changed(); tell({ kind: 'ready', height: null }) } }, 1000)
        return
      case 'kybern-visual-draft': tell({ kind: 'draft', value: data.value, label: typeof data.label === 'string' ? data.label : undefined }); return
      case 'kybern-visual-submit': tell({ kind: 'submit' }); return
      case 'kybern-visual-escape': tell({ kind: 'escape' }); return
      case 'kybern-visual-hover': tell({ kind: 'hover', over: !!data.value }); return
      case 'kybern-visual-link': {
        const link = visualLink(data.url)
        if (link) void launchBrowser(link).catch(() => {})
        return
      }
    }
  })
}

function destroy(doc: Doc) {
  clearTimeout(doc.warm)
  docs.delete(doc.id)
  webHost.destroy(doc.id)
  const client = getClient()
  if (doc.ticket && client) void client.call('threads.visuals.revoke', { thread_id: doc.threadId, ticket: doc.ticket }).catch(() => {})
  changed()
}

/** Make room for one more document: the oldest warm one goes first, else the oldest live one is retired. */
function evict(except: string) {
  for (;;) {
    const kept = [...docs.values()].filter(doc => !doc.retiring)
    if (kept.length < MAX_DOCS) return
    const oldest = kept.filter(doc => doc.id !== except).sort((a, b) => (a.owner ? 1 : 0) - (b.owner ? 1 : 0) || a.usedAt - b.usedAt)[0]
    if (!oldest) return
    if (!oldest.owner) { destroy(oldest); continue }
    // Its owner freezes it to a picture first (the snapshot still routes here), then it goes.
    oldest.retiring = true
    for (const listener of oldest.listeners) listener({ kind: 'retire' })
    const doc = oldest
    setTimeout(() => { if (docs.get(doc.id) === doc) destroy(doc) }, RETIRE_MS)
  }
}

/**
 * Claim the visual's document for `owner`, creating it (hidden until it reports its size) when there is none. A tab or
 * the full-screen viewer takes it from the inline figure; the figure takes it back only when neither holds it.
 */
export function claimDoc(threadId: string, visualId: string, owner: DocOwner, theme: VisualTheme): string {
  route()
  const id = docId(threadId, visualId)
  let doc = docs.get(id)
  if (doc?.retiring) { destroy(doc); doc = undefined }
  if (doc) {
    if (doc.owner && doc.owner !== 'inline' && owner === 'inline') return id
    clearTimeout(doc.warm)
    doc.owner = owner; doc.usedAt = Date.now(); doc.theme = theme
    changed()
    return id
  }
  evict(id)
  doc = { id, threadId, visualId, generation: 0, ready: false, error: '', owner, usedAt: Date.now(), listeners: new Set(), theme }
  docs.set(id, doc)
  changed()
  const created = doc, client = getClient(), environment = activeEnvironment()
  // No embedded web view: nothing can show a live page, and a frame ticket minted for it would never be served.
  if (!webHost.available) { created.error = VISUAL_NO_WEB_VIEW; changed(); return id }
  if (!client) { created.error = 'Kybern is not connected. Reconnect, then reload the visual.'; changed(); return id }
  void client.call('threads.visuals.frame', { thread_id: threadId, visual_id: visualId }).then(result => {
    if (docs.get(id) !== created || environment !== activeEnvironment()) { void client.call('threads.visuals.revoke', { thread_id: threadId, ticket: result.ticket }).catch(() => {}); return }
    created.ticket = result.ticket
    const url = `${httpBase(client.endpoint.url)}/visual-frame/${encodeURIComponent(result.ticket)}` + visualThemeFragment(created.theme)
    created.generation = webHost.create(id, url, 'visual')
  }).catch(error => { if (docs.get(id) === created) { created.error = String(error?.message ?? error); changed(); for (const l of created.listeners) l({ kind: 'error', message: created.error }) } })
  return id
}

/** The owner lets go: the document stays warm (hidden, state kept) for a minute, unless another owner holds it. */
export function releaseDoc(id: string, owner: DocOwner) {
  const doc = docs.get(id)
  if (!doc || doc.owner !== owner) return
  doc.owner = null
  webHost.hide(id)
  clearTimeout(doc.warm)
  doc.warm = setTimeout(() => { if (docs.get(id) === doc && !doc.owner) destroy(doc) }, WARM_MS)
  changed()
}

/** Reload: a fresh document for the same owner. */
export function reloadDoc(id: string) {
  const doc = docs.get(id)
  if (!doc) return
  const { threadId, visualId, owner, theme } = doc
  destroy(doc)
  if (owner) claimDoc(threadId, visualId, owner, theme)
}

export function listenDoc(id: string, listener: (message: DocMessage) => void) {
  const attach = () => docs.get(id)?.listeners.add(listener)
  attach()
  // A document claimed after the listener mounted picks it up on the next change.
  const stop = subscribeDocs(attach)
  return () => { stop(); docs.get(id)?.listeners.delete(listener) }
}

export function themeDoc(id: string, theme: VisualTheme) {
  const doc = docs.get(id)
  if (!doc) return
  doc.theme = theme
  if (doc.generation) webHost.theme(id, theme)
}

let tokens = 0
/** Ask for the document as it looks now (`snapshot` message with the returned token). */
export function freezeDoc(id: string, path: string): number {
  const token = ++tokens
  webHost.snapshot(id, path, token)
  return token
}

onEnvironmentChange(() => { for (const doc of [...docs.values()]) destroy(doc) })

/**
 * Open the visual's page in the default browser (no embedded web view). It takes a fresh frame ticket, which the daemon serves
 * once and drops after 60 s, so "open again" always asks for another; a ticket the browser never received is revoked. The
 * page runs as a plain top-level document there: it can be explored but cannot answer (its bridge posts to a parent frame
 * only), so a question is answered in Kybern.
 */
export async function openVisualInBrowser(threadId: string, visualId: string, theme: VisualTheme): Promise<void> {
  const client = getClient()
  if (!client) throw Error('Kybern is not connected. Reconnect, then open the visual again.')
  const { ticket } = await client.call('threads.visuals.frame', { thread_id: threadId, visual_id: visualId })
  try { await launchBrowser(`${httpBase(client.endpoint.url)}/visual-frame/${encodeURIComponent(ticket)}` + visualThemeFragment(theme)) }
  catch (error) { void client.call('threads.visuals.revoke', { thread_id: threadId, ticket }).catch(() => {}); throw error }
}
