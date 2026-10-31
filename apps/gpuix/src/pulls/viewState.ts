// Small UI values survive unmounts; native trees and remote data are never persisted here.
import { load, save } from './persist.ts'

export type PrSection = 'summary' | 'changes' | 'timeline'
export interface PrView {
  section: PrSection
  file: string | null
  filePage: number
  query: string
  lines: number
  filter: string
  inline: boolean
  timelinePages: number
  scroll: Record<string, [number, number]>
}
const KEY = 'pulls.views'
const LIMIT = 80
export const emptyView = (): PrView => ({ section: 'summary', file: null, filePage: 1, query: '', lines: 600, filter: 'all', inline: true, timelinePages: 1, scroll: {} })

export function readView(key: string): PrView {
  const value = load<Record<string, Partial<PrView>>>(KEY, {})[key]
  if (!value || typeof value !== 'object') return emptyView()
  const scroll: PrView['scroll'] = {}
  if (value.scroll && typeof value.scroll === 'object') {
    for (const [slot, anchor] of Object.entries(value.scroll).slice(-12)) {
      if (Array.isArray(anchor) && anchor.length === 2 && anchor.every(Number.isFinite) && Number.isInteger(anchor[0]) && anchor[0] >= 0) scroll[slot] = anchor
    }
  }
  return {
    section: ['summary', 'changes', 'timeline'].includes(value.section ?? '') ? value.section! : 'summary',
    file: typeof value.file === 'string' ? value.file.slice(0, 8192) : null,
    filePage: typeof value.filePage === 'number' && Number.isInteger(value.filePage) ? Math.max(1, Math.min(100, value.filePage)) : 1,
    query: typeof value.query === 'string' ? value.query.slice(0, 256) : '',
    lines: typeof value.lines === 'number' && Number.isInteger(value.lines) && value.lines >= 600 ? Math.min(value.lines, Number.MAX_SAFE_INTEGER) : 600,
    filter: typeof value.filter === 'string' ? value.filter : 'all',
    inline: typeof value.inline === 'boolean' ? value.inline : true,
    timelinePages: typeof value.timelinePages === 'number' && Number.isInteger(value.timelinePages) ? Math.max(1, Math.min(300, value.timelinePages)) : 1,
    scroll,
  }
}

export function saveView(key: string, patch: Partial<PrView>) {
  const all = { ...load<Record<string, PrView>>(KEY, {}) }
  const next = { ...readView(key), ...patch }
  delete all[key]
  all[key] = next
  for (const old of Object.keys(all).slice(0, -LIMIT)) delete all[old]
  save(KEY, all)
}
