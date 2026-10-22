// The appearance file: v2 schema, migration of the old switch, per-variant independence, and the env pins.
// `KYBERN_CLIENT_CONFIG_DIR` is set before the module loads, so nothing touches the real preferences.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'kybern-appearance-'))
process.env.KYBERN_CLIENT_CONFIG_DIR = dir
process.env.KYBERN_DATA_DIR = dir
delete process.env.KYBERN_WINDOW_MATERIAL
delete process.env.KYBERN_WINDOW_OPACITY
delete process.env.KYBERN_WINDOW_BLUR
const { appearance, migrate, previewWindowMaterial, setAppearance, setWindowMaterial } = await import('./appearance.ts')
const { DEFAULT_VARIANT_MATERIAL } = await import('../platform/translucency.ts')

const files = () => readdirSync(dir).filter((f) => f.startsWith('appearance-'))
const saved = () => JSON.parse(readFileSync(path.join(dir, files()[0]!), 'utf8'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => { for (const f of files()) rmSync(path.join(dir, f)) })

describe('migrate', () => {
  test('first launch', () => {
    expect(migrate(undefined)).toEqual({ theme: 'system', window: { dark: DEFAULT_VARIANT_MATERIAL, light: DEFAULT_VARIANT_MATERIAL } })
  })
  test('the old switch on keeps whole-window glass, and the theme survives', () => {
    const m = migrate({ theme: 'dark', translucent: true })
    expect(m.theme).toBe('dark')
    expect(m.window.dark).toEqual({ material: 'translucent', opacity: 90, blur: 64, sidebarOnly: false })
    expect(m.window.light).toEqual(m.window.dark)
  })
  test('the old switch off follows the default; a bad theme falls back to system', () => {
    const m = migrate({ theme: 'sepia', translucent: false })
    expect(m.theme).toBe('system')
    expect(m.window.dark).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
  test('version 2 normalizes each variant and defaults a missing one', () => {
    const m = migrate({ version: 2, theme: 'light', window: { light: { material: 'solid', opacity: 3, blur: 0, sidebarOnly: 1 } } })
    expect(m.window.light).toEqual({ material: 'solid', opacity: 15, blur: 1, sidebarOnly: DEFAULT_VARIANT_MATERIAL.sidebarOnly })
    expect(m.window.dark).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
})

describe('writing', () => {
  test('setWindowMaterial writes v2 without `translucent` and leaves the other variant alone', () => {
    const before = appearance().window.light
    setWindowMaterial('dark', { material: 'solid', opacity: 40 })
    expect(appearance().window.dark).toMatchObject({ material: 'solid', opacity: 40 })
    expect(appearance().window.light).toEqual(before)
    const file = saved()
    expect(file.version).toBe(2)
    expect(file).not.toHaveProperty('translucent')
    expect(file.window.dark.opacity).toBe(40)
    expect(file.window.light).toEqual(before)
  })
  test('values are normalized on the way in', () => {
    setWindowMaterial('light', { opacity: 140, blur: 99 })
    expect(appearance().window.light).toMatchObject({ opacity: 100, blur: 64 })
    setWindowMaterial('light', { blur: null })
    expect(appearance().window.light.blur).toBeNull()
  })
  test('previewWindowMaterial changes the app but not the file', () => {
    setWindowMaterial('dark', { opacity: 70 })
    const text = readFileSync(path.join(dir, files()[0]!), 'utf8')
    previewWindowMaterial('dark', { opacity: 33 })
    expect(appearance().window.dark.opacity).toBe(33)
    expect(readFileSync(path.join(dir, files()[0]!), 'utf8')).toBe(text)
    setWindowMaterial('dark', { opacity: 33 })
    expect(saved().window.dark.opacity).toBe(33)
  })
  test('a preview alone creates no file', () => {
    previewWindowMaterial('light', { opacity: 20 })
    expect(files()).toEqual([])
  })
  test('setAppearance saves the theme and the window map together', () => {
    setAppearance({ theme: 'light' })
    expect(saved()).toMatchObject({ version: 2, theme: 'light' })
    expect(appearance().theme).toBe('light')
  })
})

describe('env pins', () => {
  const script = path.join(dir, 'pin.ts')
  writeFileSync(script, `import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
const a = await import(${JSON.stringify(path.join(import.meta.dir, 'appearance.ts'))})
a.setWindowMaterial('dark', { opacity: 60 })
const dir = process.env.KYBERN_CLIENT_CONFIG_DIR!
const file = readdirSync(dir).find((f) => f.startsWith('appearance-'))!
console.log(JSON.stringify({ shown: a.appearance().window, file: JSON.parse(readFileSync(path.join(dir, file), 'utf8')).window }))
`)
  const run = (env: Record<string, string>) => {
    for (const f of files()) rmSync(path.join(dir, f))
    const result = Bun.spawnSync(['bun', script], { cwd: dir, env: { ...process.env, KYBERN_CLIENT_CONFIG_DIR: dir, KYBERN_DATA_DIR: dir, ...env } })
    if (result.exitCode) throw Error(result.stderr.toString())
    return JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!) as { shown: Record<string, unknown>; file: Record<string, unknown> }
  }
  test('override both variants and are never persisted', () => {
    const { shown, file } = run({ KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_OPACITY: '50', KYBERN_WINDOW_BLUR: 'auto' })
    expect(shown.dark).toEqual({ material: 'translucent', opacity: 50, blur: null, sidebarOnly: true })
    expect(shown.light).toEqual({ material: 'translucent', opacity: 50, blur: null, sidebarOnly: true })
    // The pin stays over the saved opacity of 60; the file holds the saved value only.
    expect(file.dark).toMatchObject({ opacity: 60, blur: 64, sidebarOnly: DEFAULT_VARIANT_MATERIAL.sidebarOnly })
  })
  test('window and solid', () => {
    expect(run({ KYBERN_WINDOW_MATERIAL: 'window' }).shown.light).toMatchObject({ material: 'translucent', sidebarOnly: false })
    expect(run({ KYBERN_WINDOW_MATERIAL: 'solid' }).shown.dark).toMatchObject({ material: 'solid' })
    expect(run({ KYBERN_WINDOW_BLUR: '7', KYBERN_WINDOW_OPACITY: '999' }).shown.dark).toMatchObject({ blur: 7, opacity: 100 })
  })
})
