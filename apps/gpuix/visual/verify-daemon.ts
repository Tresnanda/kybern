// A second scratch daemon with the `scratch-project` the Notes/Tasks verify scripts expect.
//   bun visual/verify-daemon.ts up|down   (prints the data dir)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DAEMON_BIN, SCRATCH, connect, freePort, stopPid } from './fixture.ts'

const dir = path.join(SCRATCH, 'verify-data')
const pidFile = path.join(SCRATCH, 'verify.pid')
if (process.argv[2] === 'down') {
  try { stopPid(Number(readFileSync(pidFile, 'utf8'))) } catch {}
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const port = await freePort()
const child = spawn(DAEMON_BIN, ['--data-dir', dir, '--port', String(port)], { stdio: 'ignore', detached: true })
child.unref()
writeFileSync(pidFile, String(child.pid))
for (let i = 0; i < 100 && !existsSync(path.join(dir, 'daemon.token')); i++) await Bun.sleep(100)
const state = { daemonPid: child.pid!, port, token: readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim(), seeded: true }
const client = await connect(state)
const project = path.join(SCRATCH, 'scratch-project')
mkdirSync(project, { recursive: true })
if (!existsSync(path.join(project, '.git'))) {
  writeFileSync(path.join(project, 'README.md'), '# scratch\n')
  for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=f', '-c', 'user.email=f@x.io', 'commit', '-q', '-m', 'init']]) Bun.spawnSync(['git', ...a], { cwd: project })
}
await client.call('projects.add', { path: project, name: 'scratch-project' })
console.log(dir)
process.exit(0)
