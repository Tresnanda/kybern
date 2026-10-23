import { describe, expect, test } from 'bun:test'
import { chatLink } from '../../../../packages/kybern-client/src/chatLinks.ts'
import { isImageFile, resolveWorkspaceFile, underWorkspace } from './fileLinks.ts'

// ADE-66: the reply linked `apps/gpuix/src/sidebar/rows.tsx#L390` after the agent's shell had moved into `apps/gpuix/src`.
describe('file links', () => {
  test('a link carries its path and line separately, whichever way the line is written', () => {
    for (const href of ['apps/gpuix/src/sidebar/rows.tsx#L390', 'apps/gpuix/src/sidebar/rows.tsx:390', 'apps/gpuix/src/sidebar/rows.tsx:390:5', 'apps/gpuix/src/sidebar/rows.tsx#L390C5']) {
      expect(chatLink(href)).toEqual({ kind: 'file', path: 'apps/gpuix/src/sidebar/rows.tsx', line: 390 })
    }
    expect(chatLink('<sidebar/rows.tsx#L390-L402>')).toEqual({ kind: 'file', path: 'sidebar/rows.tsx', line: 390 })
    expect(chatLink('rows.tsx')).toEqual({ kind: 'file', path: 'rows.tsx' })
  })

  test('the daemon places the path; one it cannot place is null', async () => {
    const asked: string[][] = []
    const client = { call: async (_: 'threads.files.resolve', params: { paths: string[] }) => { asked.push(params.paths); return { paths: [params.paths[0] === 'sidebar/rows.tsx' ? 'apps/gpuix/src/sidebar/rows.tsx' : null] } } }
    expect(await resolveWorkspaceFile(client as never, 't1', 'sidebar/rows.tsx')).toBe('apps/gpuix/src/sidebar/rows.tsx')
    expect(await resolveWorkspaceFile(client as never, 't1', '/etc/hosts')).toBeNull()
    expect(asked).toEqual([['sidebar/rows.tsx'], ['/etc/hosts']])
    expect(await resolveWorkspaceFile(null, 't1', 'x.ts')).toBeNull()
    expect(await resolveWorkspaceFile({ call: async () => { throw new Error('older daemon') } } as never, 't1', 'x.ts')).toBeNull()
  })

  test('an absolute path under the workspace becomes relative to it', () => {
    expect(underWorkspace('/work/ade/apps/a.ts', '/work/ade')).toBe('apps/a.ts')
    expect(underWorkspace('/work/ade/apps/a.ts', '/work/ade/')).toBe('apps/a.ts')
    expect(underWorkspace('/work/ade-other/a.ts', '/work/ade')).toBeNull()
    expect(underWorkspace('apps/a.ts', '/work/ade')).toBeNull()
    expect(underWorkspace('/work/ade/a.ts', undefined)).toBeNull()
  })

  test('image files are recognised by extension', () => {
    expect(['/private/tmp/claude-501/p/s/images/1.png', 'shot.JPEG', 'a.webp'].every(isImageFile)).toBe(true)
    expect(['a.png.bak', 'a.svg', 'png'].some(isImageFile)).toBe(false)
  })
})
