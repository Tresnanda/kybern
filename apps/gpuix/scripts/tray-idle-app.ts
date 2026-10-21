// Entry for tray-idle-probe.ts: the app, or with TRAY_SOURCE=<commit> the files the trayidle lane changed as they were at
// that commit (the A/B control; pair it with that commit's addon through TRAY_ADDON).
import path from 'node:path'
if (process.env.TRAY_SOURCE) Bun.plugin({ name: 'tray-source', setup(build) {
  build.onLoad({ filter: /\/src\/(?:Composer\.tsx|requests\/ComposerTray\.tsx|composer\/(?:Menu|Completion)\.tsx)$/ }, args => {
    const root = path.resolve(import.meta.dir, '../../..')
    const source = Bun.spawnSync(['git', 'show', `${process.env.TRAY_SOURCE}:${path.relative(root, args.path)}`], { cwd: root })
    if (source.exitCode) throw Error(source.stderr.toString())
    return { contents: source.stdout.toString(), loader: 'tsx' }
  })
} })
await import('../src/main.tsx')
