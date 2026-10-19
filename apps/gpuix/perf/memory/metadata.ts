import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function metadata(out: string, addon: string, sampled = true) {
  const command = (program: string, args: string[]) => execFileSync(program, args, { encoding: 'utf8' }).trim()
  writeFileSync(path.join(out, 'metadata.json'), JSON.stringify({
    measurementRole: process.env.KYBERN_MEMORY_STACKS === '1' ? 'allocation diagnosis with stack logging; exclude timing/resource comparisons' : 'unprofiled capture',
    nativeAddonSha256: createHash('sha256').update(readFileSync(addon)).digest('hex'),
    sourceHead: command('git', ['rev-parse', 'HEAD']),
    sourceDirty: !!command('git', ['status', '--porcelain', '--untracked-files=no']),
    memoryFlags: Object.fromEntries(['KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY', 'KYBERN_IMAGE_FRAME_MOVE', 'KYBERN_IMAGE_MEMORY', 'KYBERN_EDITOR_IMAGE_MEMORY', 'KYBERN_FRAME_MEMORY', 'KYBERN_EDITOR_DETACH_MEMORY', 'KYBERN_MEMORY_EDITOR_MANY', 'KYBERN_MEMORY_EDITOR_EDITABLE', 'KYBERN_MEMORY_RELIEF', 'KYBERN_MEMORY_STACKS'].map(key => [key, process.env[key] ?? 'app default'])),
    hardware: command('sysctl', ['-n', 'machdep.cpu.brand_string']),
    macOS: command('sw_vers', ['-productVersion']), bun: Bun.version,
    fullRate: '1', display: '60 Hz Retina LCD', warmupSeconds: sampled ? 10 : null, resourceSeconds: sampled ? 15 : null,
    createdAt: new Date().toISOString(),
  }, null, 2))
}
