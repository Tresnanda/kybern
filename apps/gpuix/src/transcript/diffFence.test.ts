import { describe, expect, test } from 'bun:test'
import { diffKinds, diffRuns, hasDiffFence, isDiffLanguage, splitDiffFences } from './diffFence.ts'

describe('isDiffLanguage', () => {
  test('diff and patch, in any case, with or without more words on the fence line', () => {
    for (const tag of ['diff', 'patch', 'DIFF', ' diff ', 'diff title="x"']) expect(isDiffLanguage(tag)).toBe(true)
    for (const tag of ['', undefined, 'typescript', 'diffs', 'patches']) expect(isDiffLanguage(tag)).toBe(false)
  })
})

describe('diffKinds', () => {
  test('removed, added, hunk headers and context', () => {
    expect(diffKinds(['@@ -1,2 +1,2 @@', ' same', '-old', '+new'])).toEqual(['hunk', 'plain', 'del', 'add'])
  })
  test('the lines git puts above a hunk are muted, and --- / +++ only as a pair', () => {
    const header = ['diff --git a/a.ts b/a.ts', 'index 1a2b3c..4d5e6f 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y']
    expect(diffKinds(header)).toEqual(['hunk', 'hunk', 'hunk', 'hunk', 'hunk', 'del', 'add'])
    // A removed SQL comment is `--- comment` in a diff, and a lone one is a removal.
    expect(diffKinds(['--- comment', ' select 1'])).toEqual(['del', 'plain'])
    expect(diffKinds(['\\ No newline at end of file'])).toEqual(['hunk'])
  })
  test('a line of the issue’s example', () => {
    expect(diffKinds(['-[title + number / repository, reason, diff] [...]', '+[title + number or ... / repository, reason, diff]'])).toEqual(['del', 'add'])
  })
})

describe('diffRuns', () => {
  test('neighbouring lines of one kind share a run, and the runs are the fence exactly', () => {
    const text = '@@ -1,4 +1,4 @@\n a\n-b\n-c\n+d\n+e\n f\n'
    const runs = diffRuns(text.replace(/\n$/, ''))
    expect(runs.map(run => run.kind)).toEqual(['hunk', 'plain', 'del', 'add', 'plain'])
    expect(runs.map(run => run.text).join('\n')).toBe(text.replace(/\n$/, ''))
  })
  test('blank lines and an empty fence survive', () => {
    expect(diffRuns('')).toEqual([{ kind: 'plain', text: '' }])
    expect(diffRuns('-a\n\n+b').map(run => run.kind)).toEqual(['del', 'plain', 'add'])
  })
})

describe('splitDiffFences', () => {
  test('prose, a diff fence, prose', () => {
    const source = 'Before\n\n```diff\n-a\n+b\n```\n\nAfter'
    expect(splitDiffFences(source)).toEqual([
      { kind: 'markdown', text: 'Before\n' },
      { kind: 'diff', text: '-a\n+b', raw: '-a\n+b', language: 'diff' },
      { kind: 'markdown', text: '\nAfter' },
    ])
  })
  test('patch fences and tilde fences count; other languages do not', () => {
    expect(splitDiffFences('~~~patch\n-a\n~~~').map(s => s.kind)).toEqual(['diff'])
    expect(splitDiffFences('```ts\nconst a = 1\n```').map(s => s.kind)).toEqual(['markdown'])
  })
  test('a diff fence inside another fence or a list item stays in the Markdown', () => {
    const nested = '````md\n```diff\n-a\n```\n````'
    expect(splitDiffFences(nested)).toEqual([{ kind: 'markdown', text: nested }])
    const listed = '1. step\n   ```diff\n   -a\n   ```'
    expect(splitDiffFences(listed)).toEqual([{ kind: 'markdown', text: listed }])
  })
  test('an unfinished fence (a reply still streaming) runs to the end', () => {
    expect(splitDiffFences('Text\n```diff\n-a\n+b')).toEqual([
      { kind: 'markdown', text: 'Text' },
      { kind: 'diff', text: '-a\n+b', raw: '-a\n+b', language: 'diff' },
    ])
  })
  test('every other character is kept, in order', () => {
    const source = 'one\n```diff\n-a\n```\ntwo\n```ts\nlet x\n```\nthree\n```patch\n+b\n```'
    const joined = splitDiffFences(source).map(s => (s.kind === 'diff' ? `\`\`\`${s.language}\n${s.text}\n\`\`\`` : s.text)).join('\n')
    expect(joined).toBe(source)
  })
  test('CRLF sources split like LF ones', () => {
    const source = ['a', '```diff', '-x', '+y', '```', 'b'].join('\r\n')
    expect(splitDiffFences(source).map(s => s.kind)).toEqual(['markdown', 'diff', 'markdown'])
  })
  test('a CRLF fence draws LF lines and copies its body exactly', () => {
    const fence = splitDiffFences(['a', '```diff', '-x', '', '+y', '```', 'b'].join('\r\n')).find(s => s.kind === 'diff')
    expect(fence).toEqual({ kind: 'diff', text: '-x\n\n+y', raw: '-x\r\n\r\n+y', language: 'diff' })
  })
  test('two diff fences in a row', () => {
    expect(splitDiffFences('```diff\n-a\n```\n```diff\n+b\n```').map(s => s.kind)).toEqual(['diff', 'diff'])
  })
})

describe('hasDiffFence', () => {
  test('is a cheap test that most Markdown fails', () => {
    expect(hasDiffFence('plain text')).toBe(false)
    expect(hasDiffFence('about the diff of a patch')).toBe(false)
    expect(hasDiffFence('x\n```diff\n-a\n```')).toBe(true)
    expect(hasDiffFence('~~~ patch\n')).toBe(true)
  })
})
