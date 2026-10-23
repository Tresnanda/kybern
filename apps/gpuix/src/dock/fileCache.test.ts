import { expect, test } from 'bun:test'
import { acquireSyntax, cachedRead, MAX_DOCUMENTS, MAX_READS, peekSyntax, rememberRead } from './fileCache.ts'

function fakeRenderer() {
  let next = 0
  const live = new Set<string>()
  return {
    live,
    created: () => next,
    createSyntaxDocument: async ({ text }: { text: string }) => { const id = `d${++next}`; live.add(id); return { id, revision: 1, lineCount: text.split('\n').length } },
    releaseSyntaxDocument: (id: string) => { live.delete(id) },
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const grace = () => new Promise((resolve) => setTimeout(resolve, 1100))

test('a remount with the same text reuses the parsed document', async () => {
  const r = fakeRenderer()
  const a = acquireSyntax(r, 'a.ts', 'one')
  const first = await a.pending
  a.release()
  expect(peekSyntax(r, 'a.ts', 'one')?.id).toBe(first.id)
  const b = acquireSyntax(r, 'a.ts', 'one')
  expect((await b.pending).id).toBe(first.id)
  expect(r.created()).toBe(1)
  b.release()
})

test('changed text parses again and releases the old document once nobody holds it', async () => {
  const r = fakeRenderer()
  const a = acquireSyntax(r, 'a.ts', 'one')
  const old = await a.pending
  const b = acquireSyntax(r, 'a.ts', 'two')
  await b.pending
  expect(peekSyntax(r, 'a.ts', 'one')).toBeUndefined()
  await grace()
  expect(r.live.has(old.id)).toBe(true)
  a.release()
  await grace()
  expect(r.live.has(old.id)).toBe(false)
  b.release()
})

test('documents and reads stay bounded', async () => {
  const r = fakeRenderer()
  for (let i = 0; i < MAX_DOCUMENTS + 3; i++) { const lease = acquireSyntax(r, `f${i}.ts`, 'x'); await lease.pending; lease.release() }
  await tick()
  await grace()
  expect(r.live.size).toBe(MAX_DOCUMENTS)
  for (let i = 0; i < MAX_READS + 2; i++) rememberRead('t:1', `f${i}`, { content: `${i}`, truncated: false, binary: false, size: 1 })
  expect(cachedRead('t:1', 'f0')).toBeUndefined()
  expect(cachedRead('t:1', `f${MAX_READS + 1}`)?.content).toBe(`${MAX_READS + 1}`)
})
