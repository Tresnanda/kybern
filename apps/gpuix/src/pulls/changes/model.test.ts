import { describe, expect, test } from 'bun:test'
import { filterFiles, flattenList, flattenTree, MAX_PRS, prKey, prune, setClosed, visibleFiles, type FileMeta, type FolderStore } from './model.ts'

const file = (path: string, over: Partial<FileMeta> = {}): FileMeta => ({ path, old_path: null, status: 'modified', additions: 1, deletions: 1, page: 1, patch_truncated: false, ...over })
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
})

describe('closed folders', () => {
  const key = prKey('p1', 108)

  test('closed folders are remembered per pull request', () => {
    const store = setClosed({}, key, ['docs', 'src'], 1)
    expect(store[key]!.closed).toEqual(['docs', 'src'])
    expect(setClosed(store, prKey('p1', 109), ['x'], 2)[key]!.closed).toEqual(['docs', 'src'])
  })

  test('the store keeps the newest 200 pull requests', () => {
    let store: FolderStore = {}
    for (let i = 0; i < MAX_PRS + 5; i++) store = setClosed(store, prKey('p', i), ['docs'], i)
    expect(Object.keys(store).length).toBe(MAX_PRS)
    expect(store[prKey('p', 0)]).toBeUndefined()
    expect(store[prKey('p', MAX_PRS + 4)]).toBeDefined()
    expect(prune(store)).toBe(store)
  })

  test('member repositories of a group project have their own keys', () => {
    expect(prKey('g', 108, 'api')).not.toBe(prKey('g', 108, 'docs'))
  })
})
