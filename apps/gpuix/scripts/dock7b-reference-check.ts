import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
import { until } from './dock-waits.ts'
const queue = '/tmp/kybern-gpuix-ui-queue'
if (!existsSync(queue) || !readFileSync(queue, 'utf8').split('\n').includes('dock7b')) appendFileSync(queue, 'dock7b\n')
console.log('dock7b queued for reference capture')
let release: (() => void) | undefined
await until(async () => { if (readFileSync(queue, 'utf8').trim().split('\n')[0] !== 'dock7b') return false; try { release = acquirePreviewUiLock(); return true } catch { return false } }, 'exclusive UI lock', 30 * 60000)
try {
  const out = '/Users/mymac/projects/ade/previews/gpuix/round7/dock7b'
  const pair = Bun.spawn(['bun', 'scripts/visual-pair.ts', 'dock7b-explorer', '--theme', 'both', '--out', out, '--keep'], { env: { ...process.env, VISUAL_SCRATCH: '/Users/mymac/projects/ade-gpuix-scratch/round7-dock7b/visual', GPUIX_VISUAL_AREAS: 'dock7' }, stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await pair.exited, 0)
  const reference = Bun.spawn(['node', 'scripts/dock7b-reference.mjs'], { stdout: 'inherit', stderr: 'inherit' }); assert.equal(await reference.exited, 0)
  const idle = Bun.spawn(['bun', 'scripts/dock7b-idle.ts'], { stdout: 'inherit', stderr: 'inherit' }); assert.equal(await idle.exited, 0)
} finally { release?.(); writeFileSync(queue, readFileSync(queue, 'utf8').split('\n').filter(line => line && line !== 'dock7b').join('\n') + '\n') }
const strip = Bun.spawn(['swift', 'scripts/dock7b-strips.swift'], { stdout: 'inherit', stderr: 'inherit' }); assert.equal(await strip.exited, 0)
