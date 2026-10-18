import '../../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import assert from 'node:assert/strict'
import { heapStats } from 'bun:jsc'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { each, getObjc, nsApp, sel } from '../../src/native/objc.ts'
import { RichEditor, type RichEditorHandle } from '../../src/editor/RichEditor.tsx'
import { loadEditorImage } from '../../src/editor/images.ts'
const imageDir = process.env.KYBERN_MEMORY_IMAGE_DIR ?? path.join(process.env.KYBERN_DATA_DIR!, 'memory-images')
type Scene = { kind: string; index: number; peer?: boolean }
let change: (scene: Scene) => void
let historyEditor: RichEditorHandle | null = null
let native: ReturnType<typeof useGpuixRequired>
const light = process.env.KYBERN_APPEARANCE === 'light'
function Lab() {
  native = useGpuixRequired()
  const [scene, setScene] = useState<Scene>({ kind: 'home', index: 0 })
  change = setScene
  useEffect(() => {
    const o = getObjc(), app = nsApp()
    if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => {
      o.msgSetI64(window, sel(o, 'setLevel:'), 3n)
      o.msgSetBool(window, sel(o, 'setIgnoresMouseEvents:'), true)
      o.msg(window, sel(o, 'orderFrontRegardless'))
    })
  }, [])
  const src = path.join(imageDir, `${scene.index}.png`)
  useEffect(() => {
    if (scene.kind === 'editor' || scene.kind === 'editor-history') void loadEditorImage(native, null, src)
    if (scene.kind === 'editor-many') for (let index = 0; index < 24; index++) void loadEditorImage(native, null, path.join(imageDir, `${index}.png`))
  }, [src, scene.kind])
  return <div testId="app-ready" style={{ width: '100%', height: '100%', backgroundColor: light ? '#f5f5f5' : '#202020', padding: 24 }}>
    <text testId="scene" style={{ color: light ? '#202020' : '#eeeeee', height: 30 }}>{`${scene.kind} ${scene.index}`}</text>
    {scene.kind === 'image' && <div style={{ display: 'flex' }}>
      <img key={scene.index} testId="memory-image" src={src} style={{ width: 480, height: 320, borderRadius: 12 }} />
      {scene.peer && <img testId="memory-peer" src={path.join(imageDir, '0.png')} style={{ width: 120, height: 80 }} />}
    </div>}
    {scene.kind === 'editor-history' && <RichEditor ref={value => { historyEditor = value }} value="# Image history" epoch={2000} testId="memory-editor-history" />}
    {scene.kind === 'editor-many' && <RichEditor value={'# Many images\n\n' + Array.from({ length: 24 }, (_, index) => `![Memory ${index}](${path.join(imageDir, `${index}.png`)})\n\n`).join('')} epoch={1000} readOnly={process.env.KYBERN_MEMORY_EDITOR_EDITABLE !== '1'} testId="memory-editor-many" />}
    {scene.kind === 'editor' && <RichEditor key={scene.index} value={`# Image ${scene.index}\n\n![Memory fixture](${src})\n`} epoch={scene.index} readOnly testId="memory-editor" />}
    {scene.kind === 'code' && <code testId="memory-code" code={Array.from({ length: 12000 }, (_, i) => `export const entry${i} = { title: 'Memory fixture ${i}', enabled: true };`).join('\n')} language="typescript" style={{ width: 950, height: 600, color: '#eeeeee', fontFamily: 'Menlo', fontSize: 14 }} />}
  </div>
}
render(<Lab />, { title: 'Memory residency fixture', width: 1100, height: 760, focus: false })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json() as Scene & { action: string }
  if (body.action === 'scene') change(body)
  if (body.action === 'editor-retry') {
    const renderer = native as unknown as { setRichEditorImage: (src: string, bytes: Buffer) => void; hasRichEditorImage?: (src: string) => boolean }
    if (!renderer.hasRichEditorImage) return Response.json({ available: false })
    const src = path.join(imageDir, `${body.index ?? 0}.png`)
    renderer.setRichEditorImage(src, Buffer.alloc(0))
    assert.equal(renderer.hasRichEditorImage(src), false, 'A failed entry is not a resident decode')
    await loadEditorImage(renderer, null, src)
    assert.equal(renderer.hasRichEditorImage(src), true, 'A failed load can retry')
    return Response.json({ available: true, retried: true })
  }
  if (body.action === 'editor-history') {
    assert(historyEditor, 'Editable history fixture is mounted')
    const before = historyEditor.command({ cmd: 'getDoc' })
    const src = path.join(imageDir, '0.png')
    historyEditor.command({ cmd: 'insertImage', src, alt: 'Undo image' })
    await loadEditorImage(native, null, src)
    const inserted = historyEditor.command({ cmd: 'getDoc' })
    assert(JSON.stringify(inserted).includes(src), 'Inserted image is in document')
    historyEditor.command({ cmd: 'undo' })
    assert.deepEqual(historyEditor.command({ cmd: 'getDoc' }), before, 'Undo removes the image and restores the document')
    historyEditor.command({ cmd: 'redo' })
    assert.deepEqual(historyEditor.command({ cmd: 'getDoc' }), inserted, 'Redo restores the same image document')
    return Response.json({ before, inserted, state: historyEditor.command({ cmd: 'getState' }) })
  }
  if (body.action === 'allocator-relief') {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      malloc_zone_pressure_relief: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
      malloc_default_zone: { args: [], returns: FFIType.ptr },
    })
    const variants = []
    for (const [zone, goal] of [[null, 0], [lib.symbols.malloc_default_zone(), 128 * 1024 * 1024]] as const) {
      const started = performance.now(), bytes = lib.symbols.malloc_zone_pressure_relief(zone, goal)
      variants.push({ zone: zone == null ? 'all' : 'default', goalBytes: goal, releasedBytes: String(bytes), durationMs: performance.now() - started })
    }
    lib.close()
    return Response.json({ variants })
  }
  const stats = (native as unknown as { getMemoryStats?: () => unknown }).getMemoryStats?.()
  return Response.json({ heap: heapStats(), memory: process.memoryUsage(), native: stats ?? null })
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'memory-control.json'), JSON.stringify({ port: server.port }))
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 1000).unref()
