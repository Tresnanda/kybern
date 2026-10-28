// Pure model of the Changes tab: the file tree, its flat alternative, and what "Viewed" means.
// No React and no native imports, so the unit tests run anywhere.

/** What the file list needs of a changed file. `sha` is the file's blob id at the head (absent from older daemons). */
export interface FileMeta {
  path: string
  old_path: string | null
  status: string
  additions: number
  deletions: number
  sha: string | null
  /** The 1-based page of `github.pr.page` the file's patch is on. */
  page: number
  patch_truncated: boolean
}

export type Row =
  | { kind: 'dir'; key: string; name: string; depth: number; open: boolean; files: number }
  | { kind: 'file'; key: string; file: FileMeta; name: string; dir: string; depth: number }

interface Node { name: string; path: string; dirs: Map<string, Node>; files: FileMeta[]; count: number }

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

function build(files: readonly FileMeta[]): Node {
  const root: Node = { name: '', path: '', dirs: new Map(), files: [], count: 0 }
  for (const file of files) {
    const parts = file.path.split('/')
    parts.pop()
    let node = root
    node.count++
    for (const part of parts) {
      let next = node.dirs.get(part)
      if (!next) { next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [], count: 0 }; node.dirs.set(part, next) }
      node = next
      node.count++
    }
    node.files.push(file)
  }
  return root
}

/**
 * Tree rows, folders first, then files, each sorted by name. A folder holding only one folder joins
 * it into one row ("superpowers/specs"), keyed by the deepest path. `collapsed` holds closed folder keys;
 * `forceOpen` (a filter is active) shows every folder open.
 */
export function flattenTree(files: readonly FileMeta[], collapsed: ReadonlySet<string>, forceOpen = false): Row[] {
  const rows: Row[] = []
  const visit = (node: Node, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => byName(a.name, b.name))
    for (let dir of dirs) {
      let name = dir.name
      while (!dir.files.length && dir.dirs.size === 1) {
        dir = dir.dirs.values().next().value as Node
        name = `${name}/${dir.name}`
      }
      const open = forceOpen || !collapsed.has(dir.path)
      rows.push({ kind: 'dir', key: dir.path, name, depth, open, files: dir.count })
      if (open) visit(dir, depth + 1)
    }
    for (const file of [...node.files].sort((a, b) => byName(a.path, b.path))) {
      rows.push({ kind: 'file', key: file.path, file, name: file.path.slice(file.path.lastIndexOf('/') + 1), dir: '', depth })
    }
  }
  visit(build(files), 0)
  return rows
}

/** The flat alternative: GitHub's own order, each row with its folder as a second part. */
export function flattenList(files: readonly FileMeta[]): Row[] {
  return files.map(file => {
    const cut = file.path.lastIndexOf('/')
    return { kind: 'file', key: file.path, file, name: file.path.slice(cut + 1), dir: cut < 0 ? '' : file.path.slice(0, cut + 1), depth: 0 }
  })
}

export function filterFiles(files: readonly FileMeta[], query: string): FileMeta[] {
  const q = query.trim().toLowerCase()
  return q ? files.filter(f => f.path.toLowerCase().includes(q) || f.old_path?.toLowerCase().includes(q)) : [...files]
}

/** The files in the order the rows show them, so Up and Down move through the list as it reads. */
export const visibleFiles = (rows: readonly Row[]): FileMeta[] => rows.flatMap(r => (r.kind === 'file' ? [r.file] : []))

// ---- Viewed ----

/**
 * What a file looked like when it was marked: its blob sha, or (daemon without shas) a weak stand-in from
 * its status and line counts. The two kinds are never compared, so a daemon update cannot unmark anything.
 */
export function signature(file: Pick<FileMeta, 'sha' | 'status' | 'additions' | 'deletions'>): string {
  return file.sha ? `b:${file.sha}` : `s:${file.status}:${file.additions}:${file.deletions}`
}

export type ViewedState = 'viewed' | 'changed' | 'none'

/** Per pull request: viewed files by path with the signature they were marked at, and the folders the reader closed. */
export interface PrViewed { at: number; files: Record<string, string>; closed: string[] }
export type ViewedStore = Record<string, PrViewed>

export const MAX_PRS = 200
export const MAX_PATHS = 3000

export const prKey = (projectId: string, number: number, repo?: string) => `${projectId}${repo ? `/${repo}` : ''}#${number}`

export function viewedState(entry: PrViewed | undefined, file: FileMeta): ViewedState {
  const saved = entry?.files[file.path]
  if (saved === undefined) return 'none'
  const now = signature(file)
  if (saved === now || saved[0] !== now[0]) return 'viewed'
  return 'changed'
}

export function viewedCount(entry: PrViewed | undefined, files: readonly FileMeta[]): number {
  let n = 0
  for (const f of files) if (viewedState(entry, f) === 'viewed') n++
  return n
}

/** Keep the newest `max` pull requests. */
export function prune(store: ViewedStore, max = MAX_PRS): ViewedStore {
  const keys = Object.keys(store)
  if (keys.length <= max) return store
  const keep = keys.sort((a, b) => (store[b]!.at - store[a]!.at)).slice(0, max)
  return Object.fromEntries(keep.map(k => [k, store[k]!]))
}

const empty = (now: number): PrViewed => ({ at: now, files: {}, closed: [] })

/** Mark or unmark `files` for one pull request; returns a new store, touched and pruned. */
export function setViewed(store: ViewedStore, key: string, files: readonly FileMeta[], on: boolean, now = Date.now()): ViewedStore {
  const entry = store[key] ?? empty(now)
  const next = { ...entry.files }
  for (const f of files) {
    if (on) next[f.path] = signature(f)
    else delete next[f.path]
  }
  if (Object.keys(next).length > MAX_PATHS) return store
  return prune({ ...store, [key]: { ...entry, at: now, files: next } })
}

export function setClosed(store: ViewedStore, key: string, closed: readonly string[], now = Date.now()): ViewedStore {
  const entry = store[key] ?? empty(now)
  return prune({ ...store, [key]: { ...entry, at: now, closed: closed.slice(0, 500) } })
}

/** The files between two rows of the visible order, both ends included (Shift-click). */
export function rangeBetween(order: readonly FileMeta[], a: string, b: string): FileMeta[] {
  const i = order.findIndex(f => f.path === a)
  const j = order.findIndex(f => f.path === b)
  if (i < 0 || j < 0) return j < 0 ? [] : [order[j]!]
  return order.slice(Math.min(i, j), Math.max(i, j) + 1)
}

/** "11 of 20 viewed" with the number format the rest of the page uses. */
export const viewedLabel = (viewed: number, total: number) => `${viewed.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} viewed`
