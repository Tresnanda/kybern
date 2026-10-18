import assert from 'node:assert/strict'
import { metadata } from './metadata.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { lease } from './lease.ts'
import { onExit } from '../bench/lifetime.ts'
const label = process.argv[2] ?? 'visual'
const data = process.env.KYBERN_DATA_DIR!
const addon = process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.resolve(import.meta.dir, '../../native/build', label.startsWith('before') ? 'memory-before.node' : 'gpuix-native.darwin-arm64.node')
const out = `${process.env.KYBERN_MEMORY_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/memory'}/${label}-visual`
mkdirSync(out, { recursive: true })
metadata(out, addon, false)
for (const theme of ['dark', 'light']) {
 const release = await lease(), leave = onExit(release)
 const client = path.join(data, `${label}-visual-${theme}`); mkdirSync(client, { recursive: true })
 const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), { NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_URL: '', KYBERN_TOKEN: '', GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', KYBERN_APPEARANCE: theme })
 const stop = onExit(f.close)
 try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = JSON.parse(readFileSync(path.join(client, 'memory-control.json'), 'utf8')).port
  const scene = async (kind: string, index = 0, peer = false) => { await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action: 'scene', kind, index, peer }) }); await Bun.sleep(450) }
  const stats = async () => (await (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action: 'stats' }) })).json()) as { native: { images: { leasedImages: number; entries: number; dormantBytes: number; dormantBudgetBytes: number }; editorImages: { entries: number } } | null }
  const window = execFileSync('swift', [path.join(import.meta.dir, '../../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
  const capture = (name: string) => execFileSync('screencapture', ['-x', '-o', '-l', window, path.join(out, `${theme}-${name}.png`)])
  await scene('image', 0, true); capture('image-shared')
  for (let i = 1; i < 48; i++) await scene('image', i, true)
  const leased = await stats()
  if (leased.native) {
   assert.equal(leased.native.images.leasedImages, 2, 'Peer and current image stay leased')
   assert(leased.native.images.dormantBytes <= leased.native.images.dormantBudgetBytes)
  }
  capture('peer-after-eviction')
  await scene('home'); const closed = await stats()
  if (closed.native) assert.equal(closed.native.images.entries, 0, 'Last image owner releases decoded asset and atlas')
  capture('home')
  await scene('image', 0, true); capture('image-reopened')
  await scene('editor', 0); capture('editor')
  await scene('home'); const editorClosed = await stats()
  if (editorClosed.native) assert.equal(editorClosed.native.editorImages.entries, 0, 'Closed notes release image decodes')
  await scene('editor', 0); capture('editor-reopened')
  const retry = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action: 'editor-retry', index: 0 }) })
  assert(retry.ok, await retry.text())
  await scene('code'); capture('code')
  await scene('home'); capture('home-after-code')
  writeFileSync(path.join(out, `${theme}-ownership.json`), JSON.stringify({ leased, closed, editorClosed, reopened: await stats() }, null, 2))
 } finally { await f.close(); stop(); release(); leave() }
}
