// Point for me, the page side: finds the Preview and the live visuals of a thread, runs the picker in them (`pickerScript.ts`),
// turns what it posts into typed events, and captures an element's crop. Also the ⌥-click anchor: while a page is loaded the
// picker listens for it, and the composer gets a chip (`composer/store.ts` `insertIntoComposer`).
//
// What a page sends is the page's data: strings are re-bounded here, numbers re-checked, anything else is dropped.
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webHost, type WebEvent } from '../native/webview.ts'
import { insertChipIntoComposer, uploadBytes } from '../composer/store.ts'
import { anchorMentionPart } from '../../../../packages/kybern-client/src/userInput.ts'
import { toast } from '../shell/toasts.tsx'
import { PICKER_SOURCE } from './pickerScript.ts'

export interface ElementBox { x: number; y: number; width: number; height: number }
/** What the picker read from the page for one element. */
export interface ElementPayload {
  selector: string
  tag?: string
  text?: string
  html?: string
  page_url?: string
  /** `data-kybern-id` of the element or its nearest owner, in a visual. */
  id?: string
  box?: ElementBox
}
export interface ElementShot { assetId: string; dataUri: string }

export type PickSource = 'preview' | 'visual'
export type PickMessage = { hostId: string; event: 'picked' | 'cancelled' | 'anchor'; payload: ElementPayload | null }

const LIMITS = { selector: 400, tag: 40, text: 300, html: 1500, page_url: 500, id: 200 } as const
const bounded = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e6 ? value : undefined

/** An untrusted page payload as a bounded `ElementPayload`, or null when it names no element. */
export function cleanPayload(raw: unknown): ElementPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const selector = bounded(data.selector, LIMITS.selector)
  if (!selector) return null
  const out: ElementPayload = { selector }
  for (const key of ['tag', 'text', 'html', 'page_url', 'id'] as const) {
    const value = bounded(data[key], LIMITS[key])
    if (value) out[key] = value
  }
  const box = data.box as Record<string, unknown> | undefined
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(key => finite(box?.[key]))
  if (x !== undefined && y !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0) out.box = { x, y, width, height }
  return out
}

export const previewHostId = (threadId: string) => `preview:${threadId}`
/** The documents of this thread a pick can run in: its Preview, or its inline visuals that are showing. */
export function liveHosts(threadId: string, source: PickSource): string[] {
  const ids = webHost.documents()
  return source === 'preview' ? ids.filter(id => id === previewHostId(threadId)) : ids.filter(id => id.startsWith(`visual:${threadId}:`))
}
const threadOf = (hostId: string) => hostId.startsWith('preview:') ? hostId.slice('preview:'.length) : hostId.startsWith('visual:') ? hostId.split(':')[1] ?? null : null

const listeners = new Set<(message: PickMessage) => void>()
export function onPickMessage(listener: (message: PickMessage) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

let started = false
/** Listens for picker messages from every page and keeps the ⌥-click listener installed as pages load. Once, at startup. */
export function startPickHub() {
  if (started) return
  started = true
  webHost.subscribe((event: WebEvent) => {
    if (threadOf(event.id) === null) return
    // Each document load tells us its frame; the picker installs (once per document) so ⌥-click works before any pick starts.
    if (event.type === 'navigation') { void installPicker(event.id).catch(() => {}); return }
    if (event.type !== 'frameMessage' || event.data?.kind !== 'pick') return
    const name = event.data.event
    if (name !== 'picked' && name !== 'cancelled' && name !== 'anchor') return
    const payload = cleanPayload(event.data.payload)
    if (name !== 'cancelled' && !payload) return
    for (const listener of listeners) { try { listener({ hostId: event.id, event: name, payload }) } catch (error) { console.error('[pick]', error) } }
  })
  onPickMessage(message => { if (message.event === 'anchor' && message.payload) void anchorFromPage(message.hostId, message.payload) })
}

export const installPicker = (hostId: string) => webHost.frame(hostId, PICKER_SOURCE)

/** Draw the overlay in the page and hand it the keyboard, so Esc reaches it. */
export async function startPicking(hostId: string) {
  await installPicker(hostId)
  await webHost.frame(hostId, 'window.__kybernPicker.start()')
  webHost.focus(hostId)
}

export function stopPicking(hostId: string) {
  void webHost.frame(hostId, 'window.__kybernPicker && window.__kybernPicker.stop()').catch(() => {})
  webHost.releaseFocus()
}

/** A crop of the element, uploaded for the agent. Null when the page cannot be captured (the pick still works without it). */
export async function captureElement(hostId: string, box: ElementBox | undefined): Promise<ElementShot | null> {
  if (!box) return null
  const path = join(tmpdir(), `kybern-pick-${crypto.randomUUID()}.png`)
  try {
    // The overlay is gone one frame after the click; the crop is of the page itself.
    await new Promise(resolve => setTimeout(resolve, 90))
    await webHost.snapshotRect(hostId, box, path)
    const bytes = readFileSync(path)
    const asset = await uploadBytes('element.png', 'image/png', bytes)
    return { assetId: asset.id, dataUri: `data:image/png;base64,${bytes.toString('base64')}` }
  } catch { return null } finally { try { rmSync(path, { force: true }) } catch { /* already gone */ } }
}

/** `tag "text"`, or the visual's own id. */
export function anchorLabel(payload: ElementPayload): string {
  if (payload.id) return payload.id
  const text = (payload.text ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim()
  const tag = payload.tag ?? 'element'
  return text ? `${tag} “${text.length > 24 ? `${text.slice(0, 23)}…` : text}”` : payload.selector.length > 36 ? `${payload.selector.slice(0, 35)}…` : payload.selector
}

/** ⌥-click: the element becomes a chip in the thread's composer; the message carries its selector, text, a short HTML snippet and a crop. */
async function anchorFromPage(hostId: string, payload: ElementPayload) {
  const threadId = threadOf(hostId)
  if (!threadId) return
  const shot = await captureElement(hostId, payload.box)
  // The chip travels in the message, so its snippet is shorter than a pick's.
  const part = anchorMentionPart(anchorLabel(payload), { ...payload, html: payload.html?.slice(0, 600), ...(shot ? { screenshot_asset: shot.assetId } : {}) })
  // With the Preview in front there is no composer to show it in: the chip waits for the chat, and a toast says so.
  const inserted = insertChipIntoComposer(`thread:${threadId}`, part)
  if (!inserted) toast('Added to your message', { description: `${anchorLabel(payload)} is waiting in the chat's composer.` })
}
