import { parseRecents, PREVIEW_RECENTS_CAP, type PreviewRecent as BaseRecent } from '../../../../packages/kybern-client/src/previewRecents.ts'
import type { RemoteServer } from './remote.ts'

/** Kept only in this desktop's preferences, with the original source rather than its disposable forwarded URL. */
export type PreviewRecent = BaseRecent & { machine?: RemoteServer }
export const recentIdentity = (recent: PreviewRecent): string => JSON.stringify([recent.kind, recent.machine ? [recent.machine.id, recent.machine.port, recent.machine.path, recent.machine.scheme ?? 'http'] : recent.value])
export function addSourceRecent(list: readonly PreviewRecent[], recent: PreviewRecent): PreviewRecent[] {
  const identity = recentIdentity(recent)
  return [recent, ...list.filter(item => recentIdentity(item) !== identity)].slice(0, PREVIEW_RECENTS_CAP)
}
export function parseSourceRecents(json: string | null | undefined): PreviewRecent[] {
  let raw: unknown
  try { raw = JSON.parse(json ?? 'null') } catch { return [] }
  if (!Array.isArray(raw)) return []
  const valid: PreviewRecent[] = []
  for (const item of raw) {
    const recent = parseRecents(JSON.stringify([item]))[0]
    if (!recent) continue
    if (Object.hasOwn(item, 'machine')) {
      const m = item.machine
      // Refuse a damaged source instead of treating its localhost URL as a different machine's server.
      if (recent.kind !== 'server' || !m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || m.id.length > 256 || typeof m.name !== 'string' || m.name.length > 256 || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535 || typeof m.path !== 'string' || m.path.length > 2048 || (m.path && !m.path.startsWith('/')) || (m.scheme !== undefined && m.scheme !== 'http' && m.scheme !== 'https')) continue
      valid.push({ ...recent, machine: { id: m.id, name: m.name, port: m.port, path: m.path, ...(m.scheme ? { scheme: m.scheme } : {}) } })
    } else valid.push(recent)
  }
  valid.sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  return valid.filter(recent => { const key = recentIdentity(recent); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, PREVIEW_RECENTS_CAP)
}
