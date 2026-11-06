import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TranscriptCache } from '../../../../packages/kybern-client/src/transcriptCache.ts'
import { emptyThreadState, type Block, type ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { CACHED_ROWS, SCHEMA, cacheableState, createTranscriptCache, openSqliteStore } from './diskCache.ts'

const dirs: string[] = []
const cacheFile = () => { const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-cache-')); dirs.push(dir); return path.join(dir, 'transcripts.sqlite') }
const stores: { close(): void }[] = []
/** Every store is closed before its folder goes (Windows keeps open files locked). */
const openStore = (file: string) => { const store = openSqliteStore(file); stores.push(store); return store }
afterEach(() => {
  for (const store of stores.splice(0)) try { store.close() } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const thread = (id: string, last_seq: number) => ({ id, title: id, status: 'idle', last_seq, project_id: 'p', updated_at: '2026-11-01T00:00:00Z' }) as unknown as Thread
const user = (turn: number, seq: number): Block => ({ kind: 'user', id: `u${turn}`, turnId: `t${turn}`, seq, at: '2026-11-01T00:00:00Z', parts: [] } as unknown as Block)
const answer = (turn: number, seq: number): Block => ({ kind: 'assistant', id: `a${turn}`, turnId: `t${turn}`, seq, at: '2026-11-01T00:00:00Z', text: 'x' } as unknown as Block)
function stateOf(id: string, turns: number, rowsPerTurn = 2): ThreadState {
  const blocks: Block[] = []
  let seq = 0
  for (let t = 0; t < turns; t++) { blocks.push(user(t, ++seq)); for (let r = 1; r < rowsPerTurn; r++) blocks.push({ ...answer(t, ++seq), id: `a${t}-${r}` } as Block) }
  return { ...emptyThreadState(), thread: thread(id, seq), blocks, lastSeq: seq, loaded: true }
}
const immediate = { firstDelayMs: 0, intervalMs: 0 }

describe('the bun:sqlite transcript cache', () => {
  test('a saved transcript loads back with its cursor, from a new process (a new store on the same file)', async () => {
    const file = cacheFile()
    const store = openStore(file)
    const cache = new TranscriptCache<ThreadState>(store, { schema: SCHEMA, timing: immediate })
    const open = stateOf('t1', 3)
    cache.schedule('m1', 't1', () => ({ lastSeq: open.lastSeq, data: cacheableState(open) }))
    await cache.flush()
    store.close()
    const again = createTranscriptCache(openStore(file))
    const loaded = await again.load('m1', 't1')
    expect(loaded?.lastSeq).toBe(6)
    expect(loaded?.data.blocks.map(b => b.id)).toEqual(open.blocks.map(b => b.id))
    expect(await again.load('m1', 'other')).toBeUndefined()
    expect(await again.load('m2', 't1')).toBeUndefined()
  })

  test('a record of another schema version, or an unreadable one, is deleted and missed', async () => {
    const file = cacheFile()
    const store = openStore(file)
    const old = new TranscriptCache<ThreadState>(store, { schema: SCHEMA - 1, timing: immediate })
    const open = stateOf('t1', 1)
    old.schedule('m1', 't1', () => ({ lastSeq: 2, data: open }))
    await old.flush()
    const current = createTranscriptCache(store)
    expect(await current.load('m1', 't1')).toBeUndefined()
    expect((await current.stats()).entries).toBe(0)
    const db = new Database(file)
    db.query('INSERT INTO transcript_cache VALUES (?,?,?,?,?,?,?)').run('m1', 'bad', SCHEMA, 1, 5, 1, '{nope')
    db.query('INSERT INTO transcript_cache VALUES (?,?,?,?,?,?,?)').run('m1', 'shape', SCHEMA, 1, 5, 1, '{"blocks":"no"}')
    db.close()
    const fresh = createTranscriptCache(openStore(file))
    expect(await fresh.load('m1', 'bad')).toBeUndefined()
    expect(await fresh.load('m1', 'shape')).toBeUndefined()
    expect((await fresh.stats()).entries).toBe(0)
  })

  test('the least recently used records go first past the entry bound', async () => {
    let now = 1000
    const store = openStore(cacheFile())
    const cache = new TranscriptCache<ThreadState>(store, { schema: SCHEMA, timing: immediate, limits: { maxEntries: 2 }, now: () => now++ })
    for (const id of ['a', 'b']) { const s = stateOf(id, 1); cache.schedule('m', id, () => ({ lastSeq: s.lastSeq, data: s })) ; await cache.flush() }
    await cache.load('m', 'a') // a is now the most recently used
    const c = stateOf('c', 1)
    cache.schedule('m', 'c', () => ({ lastSeq: c.lastSeq, data: c }))
    await cache.flush()
    expect(await cache.load('m', 'b')).toBeUndefined()
    expect((await cache.load('m', 'a'))?.data.thread?.id).toBe('a')
    expect((await cache.load('m', 'c'))?.data.thread?.id).toBe('c')
  })

  test('wiping a machine removes only its records', async () => {
    const file = cacheFile()
    const cache = new TranscriptCache<ThreadState>(openStore(file), { schema: SCHEMA, timing: immediate })
    for (const [m, id] of [['gone', 'x'], ['gone', 'y'], ['kept', 'z']] as const) { const s = stateOf(id, 1); cache.schedule(m, id, () => ({ lastSeq: s.lastSeq, data: s })) }
    await cache.flush()
    await cache.wipeMachine('gone')
    const fresh = createTranscriptCache(openStore(file))
    expect(await fresh.load('gone', 'x')).toBeUndefined()
    expect(await fresh.load('gone', 'y')).toBeUndefined()
    expect((await fresh.load('kept', 'z'))?.lastSeq).toBe(2)
  })
})

describe('cacheableState', () => {
  test('keeps whole newest turns up to the row bound and points the history cursor at the first kept row', () => {
    const open = stateOf('t', 400, 2) // 800 rows
    const kept = cacheableState({ ...open, loadingEarlier: true })
    expect(kept.blocks.length).toBeLessThanOrEqual(CACHED_ROWS)
    expect(kept.blocks[0]!.kind).toBe('user')
    expect(kept.nextBeforeSeq).toBe(kept.blocks[0]!.seq)
    expect(kept.blocks.at(-1)).toBe(open.blocks.at(-1)!)
    expect(kept.loadingEarlier).toBe(false)
    expect(kept.lastSeq).toBe(open.lastSeq)
  })
  test('a short transcript is kept whole with its own cursor', () => {
    const open = { ...stateOf('t', 3), nextBeforeSeq: 77 }
    expect(cacheableState(open).blocks).toBe(open.blocks)
    expect(cacheableState(open).nextBeforeSeq).toBe(77)
  })
})
