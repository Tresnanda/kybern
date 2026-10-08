/** Recent previews list (pure ops; the app persists the JSON). */

export const PREVIEW_RECENTS_CAP = 10
export const PREVIEW_RECENT_MAX_VALUE = 2048
export const PREVIEW_RECENT_MAX_TITLE = 256

export type PreviewRecentKind = "file" | "server" | "external"

export type PreviewRecent = {
  kind: PreviewRecentKind
  /** Absolute path or full URL. */
  value: string
  title?: string
  /** Epoch ms of the last open. */
  at: number
}

const same = (a: PreviewRecent, b: PreviewRecent) => a.kind === b.kind && a.value === b.value

/** Adds as newest, drops an older duplicate, caps the list. */
export function addRecent(
  list: readonly PreviewRecent[],
  entry: PreviewRecent,
  cap: number = PREVIEW_RECENTS_CAP,
): PreviewRecent[] {
  return [entry, ...list.filter((item) => !same(item, entry))].slice(0, cap)
}

export function removeRecent(
  list: readonly PreviewRecent[],
  kind: PreviewRecentKind,
  value: string,
): PreviewRecent[] {
  return list.filter((item) => !(item.kind === kind && item.value === value))
}

/** Parses stored JSON; invalid entries are dropped, order is newest first, deduped and capped. */
export function parseRecents(json: string | null | undefined): PreviewRecent[] {
  if (!json) return []
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const valid: PreviewRecent[] = []
  for (const raw of data) {
    const entry = validRecent(raw)
    if (entry) valid.push(entry)
  }
  valid.sort((a, b) => b.at - a.at)
  const out: PreviewRecent[] = []
  for (const entry of valid) if (!out.some((item) => same(item, entry))) out.push(entry)
  return out.slice(0, PREVIEW_RECENTS_CAP)
}

export function serializeRecents(list: readonly PreviewRecent[]): string {
  return JSON.stringify(list.slice(0, PREVIEW_RECENTS_CAP))
}

function validRecent(raw: unknown): PreviewRecent | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.kind !== "file" && r.kind !== "server" && r.kind !== "external") return null
  if (typeof r.value !== "string" || !r.value || r.value.length > PREVIEW_RECENT_MAX_VALUE) return null
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null
  const entry: PreviewRecent = { kind: r.kind, value: r.value, at: r.at }
  if (typeof r.title === "string" && r.title.length <= PREVIEW_RECENT_MAX_TITLE) entry.title = r.title
  return entry
}
