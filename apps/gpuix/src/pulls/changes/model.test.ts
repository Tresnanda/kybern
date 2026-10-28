import { describe, expect, test } from 'bun:test'
import { filterFiles, flattenList, flattenTree, MAX_PRS, prKey, prune, rangeBetween, setClosed, setViewed, signature, viewedCount, viewedState, visibleFiles, type FileMeta, type ViewedStore } from './model.ts'

const file = (path: string, over: Partial<FileMeta> = {}): FileMeta => ({ path, old_path: null, status: 'modified', additions: 1, deletions: 1, sha: `sha-${path}`, page: 1, patch_truncated: false, ...over })
const names = (rows: ReturnType<typeof flattenTree>) => rows.map(r => `${' '.repeat(r.depth)}${r.kind === 'dir' ? `${r.name}/${r.open ? '' : ' (closed)'}` : r.name}`)

describe('file tree', () => {
  const files = [file('docs/platform-kb/get-new-fans.md'), file('docs/superpowers/specs/a.md'), file('docs/platform-kb/privacy.md'), file('README.md'), file('src/components/legal/CookieBanner.tsx'), file('src/lib/igStory.ts')]

  test('folders first, files sorted, single-child folders join', () => {
    expect(names(flattenTree(files, new Set()))).toEqual([
      'docs/',
      ' platform-kb/', '  get-new-fans.md', '  privacy.md',
      ' superpowers/specs/', '  a.md',
      'src/',
      ' components/legal/', '  CookieBanner.tsx',
      ' lib/', '  igStory.ts',
      'README.md',
    ])
  })

  test('a closed folder hides its rows; its key is the deepest joined path', () => {
    const rows = flattenTree(files, new Set(['docs/superpowers/specs', 'src']))
    expect(names(rows)).toContain(' superpowers/specs/ (closed)')
    expect(names(rows)).toContain('src/ (closed)')
    expect(names(rows)).not.toContain('  a.md')
    expect(rows.find(r => r.kind === 'dir' && r.name === 'superpowers/specs')?.key).toBe('docs/superpowers/specs')
  })

  test('a filter opens every folder', () => {
    const rows = flattenTree(filterFiles(files, 'cookie'), new Set(['src']), true)
    expect(names(rows)).toEqual(['src/components/legal/', ' CookieBanner.tsx'])
  })

  test('folder rows count the files below them', () => {
    const rows = flattenTree(files, new Set())
    expect(rows.find(r => r.kind === 'dir' && r.key === 'docs')).toMatchObject({ files: 3 })
  })

  test('the flat list keeps order and splits the folder off the name', () => {
    const rows = flattenList([file('src/lib/igStory.ts'), file('README.md')])
    expect(rows.map(r => r.kind === 'file' && [r.name, r.dir])).toEqual([['igStory.ts', 'src/lib/'], ['README.md', '']])
  })

  test('visibleFiles follows the rows as shown', () => {
    expect(visibleFiles(flattenTree(files, new Set(['docs']))).map(f => f.path)).toEqual(['src/components/legal/CookieBanner.tsx', 'src/lib/igStory.ts', 'README.md'])
  })

  test('rangeBetween includes both ends in either direction', () => {
    const order = visibleFiles(flattenTree(files, new Set()))
    const a = order[1]!.path, b = order[3]!.path
    expect(rangeBetween(order, a, b).map(f => f.path)).toEqual(order.slice(1, 4).map(f => f.path))
    expect(rangeBetween(order, b, a).length).toBe(3)
    expect(rangeBetween(order, 'gone', b).map(f => f.path)).toEqual([b])
  })
})

describe('viewed', () => {
  const key = prKey('p1', 108)
  const a = file('a.ts'), b = file('b.ts')

  test('marks, counts and unmarks', () => {
    let store = setViewed({}, key, [a, b], true, 1)
    expect(viewedState(store[key], a)).toBe('viewed')
    expect(viewedCount(store[key], [a, b, file('c.ts')])).toBe(2)
    store = setViewed(store, key, [a], false, 2)
    expect(viewedState(store[key], a)).toBe('none')
    expect(viewedCount(store[key], [a, b])).toBe(1)
  })

  test('a changed blob sha shows "changed" and no longer counts as viewed', () => {
    const store = setViewed({}, key, [a], true, 1)
    const pushed = { ...a, sha: 'new' }
    expect(viewedState(store[key], pushed)).toBe('changed')
    expect(viewedCount(store[key], [pushed])).toBe(0)
    // Viewing it again takes the new sha.
    expect(viewedState(setViewed(store, key, [pushed], true, 2)[key], pushed)).toBe('viewed')
  })

  test('without shas, a changed line count or status stands in', () => {
    const old = file('a.ts', { sha: null, additions: 3 })
    const store = setViewed({}, key, [old], true, 1)
    expect(viewedState(store[key], old)).toBe('viewed')
    expect(viewedState(store[key], { ...old, additions: 4 })).toBe('changed')
    expect(signature(old).startsWith('s:')).toBe(true)
  })

  test('the two signature kinds are never compared: a daemon with shas does not unmark', () => {
    const store = setViewed({}, key, [file('a.ts', { sha: null })], true, 1)
    expect(viewedState(store[key], file('a.ts'))).toBe('viewed')
    const upgraded = setViewed({}, key, [file('a.ts')], true, 1)
    expect(viewedState(upgraded[key], file('a.ts', { sha: null }))).toBe('viewed')
  })

  test('the store keeps the newest 200 pull requests', () => {
    let store: ViewedStore = {}
    for (let i = 0; i < MAX_PRS + 5; i++) store = setViewed(store, prKey('p', i), [a], true, i)
    expect(Object.keys(store).length).toBe(MAX_PRS)
    expect(store[prKey('p', 0)]).toBeUndefined()
    expect(store[prKey('p', MAX_PRS + 4)]).toBeDefined()
    expect(prune(store)).toBe(store)
  })

  test('opening a closed folder list is remembered per pull request', () => {
    const store = setClosed(setViewed({}, key, [a], true, 1), key, ['docs', 'src'], 2)
    expect(store[key]!.closed).toEqual(['docs', 'src'])
    expect(store[key]!.files['a.ts']).toBeDefined()
    expect(setClosed(store, prKey('p1', 109), ['x'], 3)[key]!.closed).toEqual(['docs', 'src'])
  })

  test('member repositories of a group project have their own keys', () => {
    expect(prKey('g', 108, 'api')).not.toBe(prKey('g', 108, 'docs'))
  })
})
