import { expect, test } from 'bun:test'
import { addSourceRecent, parseSourceRecents, recentIdentity, type PreviewRecent } from './recentSources.ts'
const recent = (id: string, at = 1): PreviewRecent => ({ kind: 'server', value: 'http://localhost:5173/app?q=1#x', at, machine: { id, name: id, port: 5173, path: '/app?q=1#x' } })
test('source recents persist original machine, port and path; same port on another machine is a separate recent', () => {
  const list = addSourceRecent(addSourceRecent([], recent('a')), recent('b', 2))
  expect(parseSourceRecents(JSON.stringify(list))).toEqual(list)
  expect(addSourceRecent(list, recent('a', 3)).map(r => r.machine?.id)).toEqual(['a', 'b'])
  expect(recentIdentity(recent('a'))).not.toBe(recentIdentity(recent('b')))
})
test('legacy local recents remain compatible and malformed source data never falls back to localhost', () => {
  const legacy: PreviewRecent = { kind: 'server', value: 'http://localhost:5173', title: 'Old', at: 1 }
  expect(parseSourceRecents(JSON.stringify([legacy]))).toEqual([legacy])
  expect(parseSourceRecents(JSON.stringify([{ ...legacy, machine: { id: 'a', port: '5173' } }, { ...legacy, machine: null }]))).toEqual([])
  expect(parseSourceRecents('broken')).toEqual([])
  expect(parseSourceRecents(JSON.stringify([recent('a'), recent('a', 2)]))).toEqual([recent('a', 2)])
})
