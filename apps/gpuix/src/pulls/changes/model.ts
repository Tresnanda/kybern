// Pure model of the Changes tab: the file tree, its flat alternative, and the folders the reader closed.
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

// ---- Closed folders ----

/** Per pull request: the folders the reader closed. */
export interface PrFolders { at: number; closed: string[] }
export type FolderStore = Record<string, PrFolders>

export const MAX_PRS = 200

export const prKey = (projectId: string, number: number, repo?: string) => `${projectId}${repo ? `/${repo}` : ''}#${number}`

/** Keep the newest `max` pull requests. */
export function prune(store: FolderStore, max = MAX_PRS): FolderStore {
  const keys = Object.keys(store)
  if (keys.length <= max) return store
  const keep = keys.sort((a, b) => (store[b]!.at - store[a]!.at)).slice(0, max)
  return Object.fromEntries(keep.map(k => [k, store[k]!]))
}

export function setClosed(store: FolderStore, key: string, closed: readonly string[], now = Date.now()): FolderStore {
  return prune({ ...store, [key]: { at: now, closed: closed.slice(0, 500) } })
}
