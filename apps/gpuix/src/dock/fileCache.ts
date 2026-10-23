// The last files the file viewers showed (ADE-54): each one's read and its syntax document, so going back to a file tab (⌘1 ↔ a
// file, ⌃Tab between files, the groups of a 2×2) neither re-reads nor re-highlights it. A viewer shows the cached read at once and
// re-reads in the background; the syntax document is reused only for the same path and the same text. Both are bounded LRUs
// (`MAX_READS` reads, `MAX_DOCUMENTS` documents per window); an evicted document is released once no viewer holds it.
import type { FilesReadResult } from '../../../../packages/kybern-client/src/types.ts'
import { createSyntaxDocument, releaseSyntaxDocument, type SyntaxDocument } from '../native/syntax.tsx'

export const MAX_READS = 8
export const MAX_DOCUMENTS = 8
// An evicted document nobody holds is released after this, so a viewer that rendered it in the same commit can still take it.
const RELEASE_GRACE_MS = 1000

const reads = new Map<string, FilesReadResult>()
const readKey = (owner: string, path: string) => `${owner}\0${path}`

/** The last read of `path` for an owner (`p:<project>` or `t:<thread>`), freshest first. */
export function cachedRead(owner: string, path: string): FilesReadResult | undefined {
  return reads.get(readKey(owner, path))
}

export function rememberRead(owner: string, path: string, file: FilesReadResult) {
  const key = readKey(owner, path)
  reads.delete(key)
  reads.set(key, file)
  while (reads.size > MAX_READS) reads.delete(reads.keys().next().value!)
}

interface Entry {
  path: string
  content: string
  pending: Promise<SyntaxDocument>
  document?: SyntaxDocument
  refs: number
  evicted: boolean
  released: boolean
  timer?: ReturnType<typeof setTimeout>
}

const documents = new WeakMap<object, Map<string, Entry>>()
const forRenderer = (renderer: object) => {
  let map = documents.get(renderer)
  if (!map) documents.set(renderer, (map = new Map()))
  return map
}

function release(renderer: object, entry: Entry) {
  if (entry.released || entry.refs > 0 || !entry.evicted) return
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    if (entry.refs > 0 || entry.released) return
    entry.released = true
    if (entry.document) releaseSyntaxDocument(renderer, entry.document.id)
    else void entry.pending.then((document) => releaseSyntaxDocument(renderer, document.id), () => {})
  }, RELEASE_GRACE_MS)
}

function evict(renderer: object, map: Map<string, Entry>, entry: Entry) {
  if (map.get(entry.path) === entry) map.delete(entry.path)
  entry.evicted = true
  release(renderer, entry)
}

/** The parsed document for this text, if one is ready (a remounting viewer draws it on its first render). */
export function peekSyntax(renderer: object, path: string, content: string): SyntaxDocument | undefined {
  const entry = forRenderer(renderer).get(path)
  return entry && !entry.released && entry.content === content ? entry.document : undefined
}

/** Holds the document for `path` with this text, parsing it unless it is cached; `release` lets it go. */
export function acquireSyntax(renderer: object, path: string, content: string): { pending: Promise<SyntaxDocument>; release: () => void } {
  const map = forRenderer(renderer)
  let entry = map.get(path)
  if (entry && (entry.content !== content || entry.released)) { evict(renderer, map, entry); entry = undefined }
  if (!entry) {
    const created: Entry = { path, content, pending: createSyntaxDocument(renderer, { text: content, path }), refs: 0, evicted: false, released: false }
    created.pending.then((document) => { created.document = document }, () => { if (map.get(path) === created) map.delete(path); created.released = true })
    entry = created
  }
  map.delete(path)
  map.set(path, entry)
  entry.refs++
  clearTimeout(entry.timer)
  for (const old of map.values()) {
    if (map.size <= MAX_DOCUMENTS) break
    if (old !== entry) evict(renderer, map, old)
  }
  const held = entry
  let done = false
  return { pending: held.pending, release: () => { if (done) return; done = true; held.refs--; release(renderer, held) } }
}
