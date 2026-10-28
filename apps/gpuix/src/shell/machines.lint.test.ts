// The guard of design §5.2 step 4: thread- and project-scoped code asks `threadClient` / `projectClient` / `callThread`
// for the machine that owns what it is working on. `getClient()` is the connection of the machine the user is at; in
// these folders a call through it would reach the wrong machine as soon as a second one is merged in. Machine-wide
// surfaces of the local machine say so with `localClient()`.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const FOLDERS = ['composer', 'transcript', 'dock', 'requests', 'terminal', 'preview', 'tabs', 'subagents', 'draft']
const FILES = ['Composer.tsx', 'Transcript.tsx']
/** Tests, mocks and on-screen checks drive the real or a fake connection directly. */
const exempt = (name: string) => /\.(test|verify)\.[tj]sx?$/.test(name) || /^verify[-.]/.test(name) || /\.fixture\.[tj]sx?$/.test(name) || /\.lab\.[tj]sx?$/.test(name)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.[tj]sx?$/.test(name) && !exempt(name) ? [full] : []
  })
}

/** Lines that name `getClient` outside a comment. */
export function offenders(source: string): number[] {
  return source.split('\n').flatMap((line, index) => (/\bgetClient\b/.test(line.replace(/\/\/.*$/, '')) ? [index + 1] : []))
}

test('thread-scoped folders never use getClient()', () => {
  const found: string[] = []
  for (const file of [...FOLDERS.flatMap((folder) => sources(path.join(root, folder))), ...FILES.map((name) => path.join(root, name))]) {
    for (const line of offenders(readFileSync(file, 'utf8'))) found.push(`${path.relative(root, file)}:${line}`)
  }
  expect(found).toEqual([])
})

test('the guard sees a real use and ignores a comment', () => {
  expect(offenders("const c = getClient()\n// getClient() is the local one\nconst d = threadClient(id)")).toEqual([1])
  expect(offenders("import { getClient, getState } from '../state.ts'")).toEqual([1])
  expect(offenders('const e = localClient()')).toEqual([])
})
