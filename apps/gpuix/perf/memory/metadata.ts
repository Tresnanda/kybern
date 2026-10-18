import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function metadata(out: string, addon: string, sampled = true) {
  const command = (program: string, args: string[]) => execFileSync(program, args, { encoding: 'utf8' }).trim()
  writeFileSync(path.join(out, 'metadata.json'), JSON.stringify({
    nativeAddonSha256: createHash('sha256').update(readFileSync(addon)).digest('hex'),
    sourceHead: command('git', ['rev-parse', 'HEAD']),
    hardware: command('sysctl', ['-n', 'machdep.cpu.brand_string']),
    macOS: command('sw_vers', ['-productVersion']), bun: Bun.version,
    fullRate: '1', display: '60 Hz Retina LCD', warmupSeconds: sampled ? 10 : null, resourceSeconds: sampled ? 15 : null,
    createdAt: new Date().toISOString(),
  }, null, 2))
}
