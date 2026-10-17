import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertScratchEnv } from './harness.ts'

// A fake home, so nothing here goes near the user's real ~/.kybern.
const home = mkdtempSync(path.join(tmpdir(), 'gpuix-guard-'))
const saved = { HOME: process.env.HOME, KYBERN_URL: process.env.KYBERN_URL, KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR }
process.env.HOME = home
delete process.env.KYBERN_URL
delete process.env.KYBERN_DATA_DIR
const real = path.join(home, '.kybern')
mkdirSync(real)
afterAll(() => { Object.assign(process.env, saved); for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; rmSync(home, { recursive: true, force: true }) })

test('a scratch data dir passes', () => {
  expect(() => assertScratchEnv({ KYBERN_DATA_DIR: path.join(home, 'scratch') })).not.toThrow()
})
test('no data dir, the real dir, a dir inside it or a link to it are refused', () => {
  expect(() => assertScratchEnv({})).toThrow(/without KYBERN_DATA_DIR/)
  expect(() => assertScratchEnv({ KYBERN_DATA_DIR: real + '/' })).toThrow(/real data directory/)
  expect(() => assertScratchEnv({ KYBERN_DATA_DIR: path.join(real, 'worktrees') })).toThrow(/real data directory/)
  const link = path.join(home, 'link')
  symlinkSync(real, link)
  expect(() => assertScratchEnv({ KYBERN_DATA_DIR: link })).toThrow(/real data directory/)
})
test('an inherited KYBERN_URL is refused unless the caller passes or clears it', () => {
  process.env.KYBERN_URL = 'ws://127.0.0.1:1/ws'
  try {
    expect(() => assertScratchEnv({ KYBERN_DATA_DIR: path.join(home, 'scratch') })).toThrow(/inherited/)
    expect(() => assertScratchEnv({ KYBERN_DATA_DIR: path.join(home, 'scratch'), KYBERN_URL: '' })).not.toThrow()
    expect(() => assertScratchEnv({ KYBERN_DATA_DIR: path.join(home, 'scratch'), KYBERN_URL: 'ws://127.0.0.1:4302/ws' })).not.toThrow()
  } finally { delete process.env.KYBERN_URL }
})
