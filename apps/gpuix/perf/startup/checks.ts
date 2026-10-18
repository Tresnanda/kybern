import { writeFileSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dir, '../../../..')
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
const env = { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target'), CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: '4', RUSTC_WRAPPER: '', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/perf-startup', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/perf-startup/client', KYBERN_URL: '', KYBERN_TOKEN: '' }
for (const [name, command, cwd] of [
  ['rust-tests', ['cargo', 'test', '-p', 'kybern-daemon', '-p', 'kybern-store'], root],
  ['clippy', ['cargo', 'clippy', '--workspace', '--', '-D', 'warnings'], root],
  ['fmt', ['cargo', 'fmt', '--all', '--check'], root],
  ['typecheck', ['pnpm', 'typecheck'], path.join(root, 'apps/gpuix')],
  ['package-typecheck', ['pnpm', 'exec', 'tsc', '-p', 'packaging/tsconfig.json', '--noEmit'], path.join(root, 'apps/gpuix')],
  ['package-build', ['bun', 'scripts/package-app.ts'], path.join(root, 'apps/gpuix')],
] as const) {
  const native = command[0] === 'cargo' || name === 'package-build', marker = '/tmp/kybern-gpuix-native-build.perf-startup'
  while (native && readdirSync('/tmp').some(name => name.startsWith('kybern-gpuix-quiet.') || name.startsWith('kybern-gpuix-build-next.'))) await Bun.sleep(1000)
  if (native) writeFileSync(marker, `perf-startup ${new Date().toISOString()}\n`)
  try {
  const start = performance.now(), child = Bun.spawn(native ? ['nice', '-n', '15', ...command] : [...command], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  writeFileSync(path.join(out, `${name}.log`), stdout + '\n' + stderr)
  console.log(JSON.stringify({ name, code, ms: performance.now() - start }))
  if (code) { console.error((stdout + stderr).slice(-6000)); throw Error(`Check failed: ${name}`) }
  } finally { if (native) rmSync(marker, { force: true }) }
}
