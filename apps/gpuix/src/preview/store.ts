import { useSyncExternalStore } from 'react'
import { classifyPreviewInput, PREVIEW_REJECTED_MESSAGE } from '../../../../packages/kybern-client/src/previewTarget.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import type { PreviewOpenResult } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, getState } from '../state.ts'
import { openUrl } from '../pulls/PrStates.tsx'
import { chooseTab, setDock } from '../dock/store.ts'
export interface Entry { address: string; url: string; title: string; ticket?: string; kind: 'file' | 'server' | 'external' }
export interface PreviewState { entries: Entry[]; index: number; floating: boolean; busy: boolean; error: string | null; permission?: { address: string; folder: string; grantable: boolean }; device: boolean; width: number; height: number; preset: string | null }
const empty: PreviewState = { entries: [], index: -1, floating: false, busy: false, error: null, device: false, width: 390, height: 844, preset: 'iphone-12-pro' }
const sessions = new Map<string, PreviewState>(), generations = new Map<string, number>()
let nextGeneration = 0
const listeners = new Set<() => void>()
export const previewState = (id: string) => sessions.get(id) ?? empty
export const usePreview = (id: string) => useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => previewState(id))
const release = (entry: Entry) => { if (entry.ticket) void getClient()?.call('previews.close', { ticket: entry.ticket }).catch(() => {}) }
export function setPreview(id: string, patch: Partial<PreviewState>) {
  if (!sessions.has(id) && sessions.size >= 40) { const key = sessions.keys().next().value!; sessions.get(key)?.entries.forEach(release); sessions.delete(key); generations.delete(key) }
  sessions.set(id, { ...previewState(id), ...patch }); listeners.forEach(l => l())
}
export function showPreview(id: string) { chooseTab(id, 'preview'); setDock(id, { open: true }) }
export async function openPreview(id: string, raw: string, allowFolder = false, launch = true) {
  const thread = getState().threads.find(t => t.id === id)
  const project = getState().projects.find(p => p.id === thread?.project_id)
  const target = classifyPreviewInput(raw, { projectRoot: thread?.cwd ?? project?.path, projectName: project?.name })
  if (target.kind === 'empty') return
  if (target.kind === 'rejected') { setPreview(id, { error: PREVIEW_REJECTED_MESSAGE }); return }
  const address = target.kind === 'search' ? `https://www.google.com/search?q=${encodeURIComponent(target.query)}` : target.kind === 'file' ? target.path : target.url
  const generation = ++nextGeneration; generations.set(id, generation)
  setPreview(id, { busy: true, error: null, permission: undefined })
  try {
    const client = getClient()!
    const result: PreviewOpenResult = await client.call('previews.open', { thread_id: id, target: address, proxy: true, ...(allowFolder ? { allow_folder: true } : {}) })
    if (generations.get(id) !== generation) { if (result.ticket) await client.call('previews.close', { ticket: result.ticket }); return }
    if (result.needs_permission) { setPreview(id, { busy: false, permission: { address, ...result.needs_permission } }); return }
    const url = result.path ? `${httpBase(client.endpoint.url)}${result.path}` : result.target.kind === 'file' ? null : result.target.url
    if (!url) throw new Error('Unable to open this local file. Choose an HTML file and try again.')
    const entry: Entry = { address, url, title: result.target.kind === 'file' ? result.target.path.split('/').pop() ?? 'Preview' : new URL(address).host, ticket: result.ticket, kind: result.target.kind }
    const current = previewState(id)
    current.entries.slice(current.index + 1).forEach(release)
    const entries = [...current.entries.slice(0, current.index + 1), entry]
    if (entries.length > 16) entries.splice(0, entries.length - 16).forEach(release)
    setPreview(id, { entries, index: entries.length - 1, busy: false })
    if (launch) openUrl(url)
  } catch (e) { if (generations.get(id) === generation) setPreview(id, { busy: false, error: String(e) }) }
}
export function navigatePreview(id: string, direction: number) {
  const current = previewState(id), index = current.index + direction
  const entry = current.entries[index]
  if (!entry) return
  setPreview(id, { index, error: null, permission: undefined }); openUrl(entry.url)
}
export function closePreview(id: string) {
  generations.set(id, ++nextGeneration)
  previewState(id).entries.forEach(release)
  setPreview(id, { entries: [], index: -1, floating: false, busy: false, error: null, permission: undefined })
}

/** Environment lifecycle hook: clear metadata and invalidate all late responses. */
export function resetPreviews() {
  for (const session of sessions.values()) session.entries.forEach(release)
  sessions.clear(); generations.clear(); nextGeneration++
  listeners.forEach(listener => listener())
}
