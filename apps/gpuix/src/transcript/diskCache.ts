// Opened transcripts on disk (#248): `bun:sqlite` under the shared `TranscriptCache`, one file in GPUIX's config
// folder, records per machine. A thread opened before draws its cached copy on the first frame and resumes from the
// cached cursor (`openFlow.ts`). Records are bounded (whole turns, at most `CACHED_ROWS` rows each; the shared cache
// keeps 64 threads / 64 MB), versioned (`SCHEMA`), and wiped with their machine.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  TranscriptCache,
  memoryTranscriptCacheStore,
  sqliteTranscriptCacheStore,
  type SqlDatabase,
  type TranscriptCacheStore,
} from '../../../../packages/kybern-client/src/transcriptCache.ts'
import type { ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'

/** Bump when the cached `ThreadState` changes shape: older records are then deleted and missed. */
export const SCHEMA = 1
/** Rows kept per record; older whole turns load from the daemon as history pages. */
export const CACHED_ROWS = 600

/** bun:sqlite as the shared minimal SQL surface. */
export function bunSqlDatabase(db: Database): SqlDatabase {
  return {
    run: (sql, params) => db.query(sql).run(...(params as (string | number)[])),
    get: <R>(sql: string, params: readonly (string | number)[]) => db.query(sql).get(...(params as (string | number)[])) as R | null,
    all: <R>(sql: string, params: readonly (string | number)[]) => db.query(sql).all(...(params as (string | number)[])) as R[],
  }
}

/** A bun:sqlite-backed store at `file` (WAL, created on first use). */
export function openSqliteStore(file: string): TranscriptCacheStore & { close(): void } {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  const store = sqliteTranscriptCacheStore(bunSqlDatabase(db))
  void store.ensure()
  return { ...store, close: () => db.close() }
}

const isThreadState = (data: unknown): data is ThreadState => {
  const value = data as Partial<ThreadState> | null
  return !!value && typeof value === 'object' && Array.isArray(value.blocks) && typeof value.lastSeq === 'number' && !!value.thread && typeof value.thread === 'object'
}

/**
 * What a record keeps: the newest whole turns up to `CACHED_ROWS` rows, nothing in flight. When rows are cut,
 * `nextBeforeSeq` points at the first kept row so the reader can still page the older ones in.
 */
export function cacheableState(open: ThreadState, maxRows = CACHED_ROWS): ThreadState {
  let blocks = open.blocks
  let nextBeforeSeq = open.nextBeforeSeq ?? null
  if (blocks.length > maxRows) {
    let start = blocks.length - maxRows
    const turn = blocks[start]!.turnId
    // Keep whole turns: move the cut forward to the first row of the next turn.
    while (start < blocks.length && blocks[start]!.turnId === turn) start++
    if (start >= blocks.length) start = blocks.length - maxRows
    blocks = blocks.slice(start)
    nextBeforeSeq = blocks[0]!.seq
  }
  return { ...open, blocks, nextBeforeSeq, loadingEarlier: false, loaded: true }
}

/** Timers that never keep the process alive on their own (a pending write-behind, a lingering session). */
export const backgroundTimers = {
  setTimeout: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); return timer },
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createTranscriptCache(store: TranscriptCacheStore, onError?: (error: unknown) => void) {
  return new TranscriptCache<ThreadState>(store, { schema: SCHEMA, validate: isThreadState, timers: backgroundTimers, ...(onError ? { onError } : {}) })
}

let shared: TranscriptCache<ThreadState> | undefined
/**
 * The app's cache: `<config>/transcripts.sqlite`. Off with `KYBERN_TRANSCRIPT_CACHE=0` (an A/B control), and kept in
 * memory for automated runs and tests without a scratch config folder, so a check never writes the user's own folder.
 */
export function transcriptCache(configDir: () => string): TranscriptCache<ThreadState> {
  if (shared) return shared
  // Automated runs and tests never write the user's own folder: without a scratch config folder they keep it in memory.
  const automated = process.env.GPUIX_BACKGROUND === '1' || process.env.NODE_ENV === 'test'
  const memory = process.env.KYBERN_TRANSCRIPT_CACHE === '0' || (automated && !process.env.KYBERN_CLIENT_CONFIG_DIR)
  let store: TranscriptCacheStore
  try { store = memory ? memoryTranscriptCacheStore() : openSqliteStore(path.join(configDir(), 'transcripts.sqlite')) }
  catch (error) { console.error('[transcript-cache] Using memory only:', error); store = memoryTranscriptCacheStore() }
  shared = createTranscriptCache(store, error => console.error('[transcript-cache]', error))
  if (process.env.KYBERN_TRANSCRIPT_CACHE === '0') {
    // The control never reads a record: every open is a miss.
    shared.load = async () => undefined
  }
  return shared
}
