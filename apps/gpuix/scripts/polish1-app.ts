// Entry for polish1-shots.ts `--source <commit>`: the app with the files this lane changed as they were at that commit (the
// before captures; pair it with that commit's addon through `--addon`). `POLISH1_FILES` narrows them (comma-separated paths
// under src/, default all three).
import path from 'node:path'
const files = (process.env.POLISH1_FILES ?? 'Composer.tsx,Transcript.tsx,sidebar/motion.tsx').split(',')
Bun.plugin({ name: 'polish1-source', setup(build) {
  build.onLoad({ filter: /\/src\/(?:Composer\.tsx|Transcript\.tsx|sidebar\/motion\.tsx)$/ }, async args => {
    const root = path.resolve(import.meta.dir, '../../..')
    if (!files.some(file => args.path.endsWith(`/src/${file}`))) return { contents: await Bun.file(args.path).text(), loader: 'tsx' }
    const source = Bun.spawnSync(['git', 'show', `${process.env.POLISH1_SOURCE}:${path.relative(root, args.path)}`], { cwd: root })
    if (source.exitCode) throw Error(source.stderr.toString())
    return { contents: source.stdout.toString(), loader: 'tsx' }
  })
} })
await import('../src/main.tsx')
