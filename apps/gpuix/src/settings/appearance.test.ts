// The appearance file: v3 schema, migration of the old switch, per-variant independence, and the env pins.
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
delete process.env.KYBERN_WINDOW_CONTENT_OPACITY
delete process.env.KYBERN_WINDOW_SURFACE_OPACITY
delete process.env.KYBERN_WINDOW_BLUR
const { appearance, migrate, previewWindowMaterial, setAppearance, setWindowMaterial, resolveMaterialPatch } = await import('./appearance.ts')
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
    expect(m.window.dark).toEqual({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOpacity: 90, contentOpacity: 90, lastContentOpacity: 90, blur: 64 })
    expect(m.window.light).toEqual(m.window.dark)
  })
  test('the old switch off follows the default; a bad theme falls back to system', () => {
    const m = migrate({ theme: 'sepia', translucent: false })
    expect(m.theme).toBe('system')
    expect(m.window.dark).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
  test('version 2 becomes version 3 in memory: opacity is the sidebar opacity, Sidebar only is content 100', () => {
    const m = migrate({ version: 2, theme: 'light', window: { light: { material: 'solid', opacity: 3, blur: 0, sidebarOnly: 1 }, dark: { material: 'translucent', opacity: 60, blur: 20, sidebarOnly: false } } })
    expect(m.window.light).toEqual({ ...DEFAULT_VARIANT_MATERIAL, material: 'solid', sidebarOpacity: 15, contentOpacity: DEFAULT_VARIANT_MATERIAL.contentOpacity, lastContentOpacity: 15, blur: 1 })
    expect(m.window.dark).toEqual({ ...DEFAULT_VARIANT_MATERIAL, sidebarOpacity: 60, contentOpacity: 60, lastContentOpacity: 60, blur: 20 })
    expect(files()).toEqual([])
  })
})

describe('writing', () => {
  test('setWindowMaterial writes v3 without `translucent` and leaves the other variant alone', () => {
    const before = appearance().window.light
    setWindowMaterial('dark', { material: 'solid', sidebarOpacity: 40 })
    expect(appearance().window.dark).toMatchObject({ material: 'solid', sidebarOpacity: 40 })
    expect(appearance().window.light).toEqual(before)
    const file = saved()
    expect(file.version).toBe(3)
    expect(file).not.toHaveProperty('translucent')
    expect(file.window.dark.sidebarOpacity).toBe(40)
    expect(file.window.light).toEqual(before)
  })
  test('values are normalized on the way in', () => {
    setWindowMaterial('light', { sidebarOpacity: 140, blur: 99, surfaceOpacity: 5 })
    expect(appearance().window.light).toMatchObject({ sidebarOpacity: 100, blur: 64, surfaceOpacity: 30 })
    setWindowMaterial('light', { blur: null })
    expect(appearance().window.light.blur).toBeNull()
  })
  test('previewWindowMaterial changes the app but not the file', () => {
    setWindowMaterial('dark', { sidebarOpacity: 70 })
    const text = readFileSync(path.join(dir, files()[0]!), 'utf8')
    previewWindowMaterial('dark', { sidebarOpacity: 33 })
    expect(appearance().window.dark.sidebarOpacity).toBe(33)
    expect(readFileSync(path.join(dir, files()[0]!), 'utf8')).toBe(text)
    setWindowMaterial('dark', { sidebarOpacity: 33 })
    expect(saved().window.dark.sidebarOpacity).toBe(33)
  })
  test('a preview alone creates no file', () => {
    previewWindowMaterial('light', { sidebarOpacity: 20 })
    expect(files()).toEqual([])
  })
  test('setAppearance saves the theme and the window map together', () => {
    setAppearance({ theme: 'light' })
    expect(saved()).toMatchObject({ version: 3, theme: 'light' })
    expect(appearance().theme).toBe('light')
  })
})

describe('the Sidebar only preset and the sliders (§5.5)', () => {
  const start = () => setWindowMaterial('dark', { contentOpacity: 80, lastContentOpacity: 80 })
  test('switching Sidebar only on remembers the content opacity, off restores it', () => {
    start()
    setWindowMaterial('dark', { sidebarOnly: true })
    expect(appearance().window.dark).toMatchObject({ contentOpacity: 100, lastContentOpacity: 80 })
    setWindowMaterial('dark', { sidebarOnly: false })
    expect(appearance().window.dark).toMatchObject({ contentOpacity: 80, lastContentOpacity: 80 })
  })
  test('off without anything remembered restores 90', () => {
    setWindowMaterial('light', { contentOpacity: 100, lastContentOpacity: 90 })
    setWindowMaterial('light', { sidebarOnly: false })
    expect(appearance().window.light.contentOpacity).toBe(90)
  })
  test('dragging content opacity below 100 turns the preset off and is remembered; 100 turns it on', () => {
    start()
    previewWindowMaterial('dark', { contentOpacity: 55 })
    expect(appearance().window.dark).toMatchObject({ contentOpacity: 55, lastContentOpacity: 55 })
    previewWindowMaterial('dark', { contentOpacity: 100 })
    expect(appearance().window.dark).toMatchObject({ contentOpacity: 100, lastContentOpacity: 55 })
  })
  test('the sidebar opacity never changes the preset', () => {
    setWindowMaterial('dark', { contentOpacity: 100 })
    setWindowMaterial('dark', { sidebarOpacity: 40 })
    expect(appearance().window.dark.contentOpacity).toBe(100)
  })
  test('the pure rule', () => {
    const m = { ...DEFAULT_VARIANT_MATERIAL, contentOpacity: 70, lastContentOpacity: 70 }
    expect(resolveMaterialPatch(m, { sidebarOnly: true })).toEqual({ contentOpacity: 100, lastContentOpacity: 70 })
    expect(resolveMaterialPatch({ ...m, contentOpacity: 100 }, { sidebarOnly: false })).toEqual({ contentOpacity: 70 })
    expect(resolveMaterialPatch(m, { sidebarOnly: false })).toEqual({})
  })
})

describe('env pins', () => {
  const script = path.join(dir, 'pin.ts')
  writeFileSync(script, `import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
const a = await import(${JSON.stringify(path.join(import.meta.dir, 'appearance.ts'))})
a.setWindowMaterial('dark', { sidebarOpacity: 60 })
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
    expect(shown.dark).toEqual({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOpacity: 50, contentOpacity: 100, blur: null })
    expect(shown.light).toEqual({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOpacity: 50, contentOpacity: 100, blur: null })
    // The pin stays over the saved opacity of 60; the file holds the saved value only.
    expect(file.dark).toMatchObject({ sidebarOpacity: 60, blur: 64, contentOpacity: DEFAULT_VARIANT_MATERIAL.contentOpacity })
  })
  test('window and solid', () => {
    expect(run({ KYBERN_WINDOW_MATERIAL: 'window' }).shown.light).toMatchObject({ material: 'translucent', sidebarOpacity: 90, contentOpacity: 90 })
    expect(run({ KYBERN_WINDOW_MATERIAL: 'solid' }).shown.dark).toMatchObject({ material: 'solid' })
    expect(run({ KYBERN_WINDOW_BLUR: '7', KYBERN_WINDOW_OPACITY: '999' }).shown.dark).toMatchObject({ blur: 7, sidebarOpacity: 100 })
  })
  test('window uses the sidebar opacity for the content unless pinned separately', () => {
    expect(run({ KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '70' }).shown.dark).toMatchObject({ sidebarOpacity: 70, contentOpacity: 70 })
    expect(run({ KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '70', KYBERN_WINDOW_CONTENT_OPACITY: '40' }).shown.dark).toMatchObject({ sidebarOpacity: 70, contentOpacity: 40 })
    expect(run({ KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_CONTENT_OPACITY: '40' }).shown.dark).toMatchObject({ contentOpacity: 100 })
    expect(run({ KYBERN_WINDOW_SURFACE_OPACITY: '80' }).shown.dark).toMatchObject({ surfaceOpacity: 80 })
  })
})
