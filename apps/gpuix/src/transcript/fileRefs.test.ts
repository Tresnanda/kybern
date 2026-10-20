import { describe, expect, test } from 'bun:test'
import { chatLink } from '../../../../packages/kybern-client/src/chatLinks.ts'
import { fileRefCandidate, fileRefCandidates, linkifyFileRefs } from '../../../../packages/kybern-client/src/fileRefs.ts'
import { fromLine } from './markdown.tsx'

// The reply that showed the inconsistency (thread "Everlace launch status check").
const reply = [
  'Fixed `src/dashboard/UnlockPremium.tsx` and the price in `harga-undangan-digital.ts:100`.',
  'Mail lives in `src/server/email/templates.ts#L183`; see [the plan](docs/plan.md) and [`notes.md`](notes.md).',
  'Routes `/panduan` and `/api/health` are up on `test.everlace.cc` (`#52`, `v1.2.3`, `useState`, `e.g.`).',
  'Live at `https://test.everlace.cc/api/health`.',
  '```ts',
  'import x from `src/inside/fence.ts`',
  '```',
].join('\n')

const files: Record<string, string> = {
  'src/dashboard/UnlockPremium.tsx': 'src/dashboard/UnlockPremium.tsx',
  'harga-undangan-digital.ts': 'src/lib/harga-undangan-digital.ts',
  'src/server/email/templates.ts': 'src/server/email/templates.ts',
}

describe('inline code file references', () => {
  test('only path-like spans outside fences and links are candidates', () => {
    expect(fileRefCandidates(reply)).toEqual([
      'src/dashboard/UnlockPremium.tsx',
      'harga-undangan-digital.ts',
      'src/server/email/templates.ts',
      '/panduan',
      '/api/health',
      'test.everlace.cc',
    ])
    expect(fileRefCandidate('lib.rs:42:7')).toEqual({ text: 'lib.rs:42:7', path: 'lib.rs', line: 42 })
    expect(fileRefCandidate('a b.ts')).toBeNull()
    expect(fileRefCandidate('src/')).toBeNull()
  })

  test('resolved spans become links around the same code; the rest stay code', () => {
    const out = linkifyFileRefs(reply, path => files[path] ?? null)
    expect(out).toContain('Fixed [`src/dashboard/UnlockPremium.tsx`](<src/dashboard/UnlockPremium.tsx>)')
    expect(out).toContain('[`harga-undangan-digital.ts:100`](<src/lib/harga-undangan-digital.ts#L100>)')
    expect(out).toContain('[`src/server/email/templates.ts#L183`](<src/server/email/templates.ts#L183>)')
    expect(out).toContain('[`notes.md`](notes.md)')
    expect(out).toContain('Routes `/panduan` and `/api/health` are up on `test.everlace.cc`')
    expect(out).toContain('Live at [`https://test.everlace.cc/api/health`](<https://test.everlace.cc/api/health>).')
    expect(out).toContain('import x from `src/inside/fence.ts`')
    // Nothing resolved yet: only the URL changes, so a settled answer renders plain first.
    expect(linkifyFileRefs('see `a.ts`', () => undefined)).toBe('see `a.ts`')
  })

  test('the link opens the file at its line through the existing chat link parser', () => {
    expect(chatLink('<src/lib/harga-undangan-digital.ts#L100>')).toEqual({ kind: 'file', path: 'src/lib/harga-undangan-digital.ts', line: 100 })
    expect(chatLink('<https://test.everlace.cc/api/health>')).toEqual({ kind: 'external', url: 'https://test.everlace.cc/api/health' })
    const odd = linkifyFileRefs('`odd%name.ts`', () => 'odd%name.ts')
    expect(chatLink(/\]\((.*)\)$/.exec(odd)![1]!)).toEqual({ kind: 'file', path: 'odd%name.ts' })
  })

  test('a linked preview starts a few lines above its line', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(fromLine(text, 10)).toEqual({ text: text.slice(text.indexOf('line 7')), start: 7 })
    expect(fromLine(text, 2)).toEqual({ text, start: 1 })
    expect(fromLine(text, 99)).toEqual({ text, start: 1 })
    expect(fromLine(text, undefined).start).toBe(1)
  })
})
