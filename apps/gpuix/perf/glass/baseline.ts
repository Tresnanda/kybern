// Round-1 sources for the "Solid unchanged" capture (spec §10.2 #1): every app source file that differs between a
// baseline commit and the working tree is served from that commit (`git show`), the rest load from disk. Same technique
// as `perf/pacing-app.ts` (`KYBERN_PACING_BASELINE`), same addon and node_modules; files added since the baseline are
// never imported by the old sources. Registered by `perf/glass/app.ts` before the app loads.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../../../..')
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Repository-relative app sources that differ from `commit` and exist there. */
export function changedSince(commit: string): string[] {
  const names = execFileSync('git', ['-C', ROOT, 'diff', '--name-only', commit, '--', 'apps/gpuix/src', 'packages/kybern-client/src'], { encoding: 'utf8' })
    .split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
  return names.filter((f) => { try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${commit}:${f}`], { stdio: 'ignore' }); return true } catch { return false } })
}

export function useBaseline(commit: string) {
  const files = changedSince(commit)
  if (!files.length) return []
  const filter = new RegExp(`^(?:${files.map((f) => escape(path.join(ROOT, f))).join('|')})$`)
  Bun.plugin({ name: 'glass-baseline', setup(build) {
    build.onLoad({ filter }, (args) => {
      const file = path.relative(ROOT, args.path)
      const result = Bun.spawnSync(['git', 'show', `${commit}:${file}`], { cwd: ROOT })
      if (result.exitCode) throw Error(result.stderr.toString())
      return { contents: result.stdout.toString(), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
    })
  } })
  return files
}
