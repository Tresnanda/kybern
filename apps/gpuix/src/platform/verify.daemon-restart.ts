// Packaged acceptance for "Resolve or spawn kybernd, restart when incompatible":
// a real older daemon (kybernd 0.8.1 from the v0.8.1 release) runs on a scratch
// data dir; the packaged app finds it through daemon.port, sees the version
// mismatch, asks it to shut down, starts its bundled kybernd and connects.
// Only the scratch daemon this script started is ever stopped.
//
//   bun src/platform/verify.daemon-restart.ts <old kybernd> <scratch data dir> <port> <out-dir>
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../packaging/harness.ts'
import { until, windowId } from './verify.lib.ts'

const [oldBinary, dataDir, port, out] = process.argv.slice(2) as [string, string, string, string]
assert.ok(oldBinary && dataDir && port && out, 'usage: <old kybernd> <data dir> <port> <out dir>')
assert.ok(dataDir.includes('ade-gpuix-scratch'), 'only a scratch data dir')
mkdirSync(out, { recursive: true })
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const bundle = path.resolve(import.meta.dir, '../../dist/Kybern GPUIX.app')
const cli = (args: string[]) => execFileSync(path.join(bundle, 'Contents/MacOS/kybern'), ['--data-dir', dataDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const info = () => { try { return JSON.parse(cli(['--json', 'info'])) } catch { return null } }
const pids = () => execFileSync('pgrep', ['-f', `data-dir ${dataDir} `], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)

const old = spawn(oldBinary, ['--data-dir', dataDir, '--port', port], { stdio: 'ignore', detached: true })
old.unref()
const oldPid = old.pid!
await until(() => existsSync(path.join(dataDir, 'daemon.port')), 'old daemon port file')
const before = execFileSync(oldBinary.replace(/kybernd$/, 'kybern'), ['--data-dir', dataDir, 'info'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
console.log(`old daemon pid ${oldPid}:`, before.trim().split('\n').find(l => /version/i.test(l)) ?? before.trim())

const app = await launchFixture('', { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: dataDir, KYBERN_CLIENT_CONFIG_DIR: path.join(dataDir, '../phase2-platform9-compat-client'), KYBERN_APPEARANCE: 'dark' })
try {
  // The bundled daemon announces itself and the window connects to it.
  await until(() => { try { process.kill(oldPid, 0); return false } catch { return true } }, 'old daemon exit', 40_000)
  console.log('ok  old 0.8.1 daemon shut down on request')
  const now = await until(() => { const i = info(); return i && i.version !== '0.8.1' ? i : null }, 'bundled daemon', 30_000) as { version: string; protocol_version: number }
  const running = pids()
  const command = execFileSync('ps', ['-o', 'command=', '-p', String(running[0])], { encoding: 'utf8' }).trim()
  console.log('new daemon:', JSON.stringify({ version: now.version, protocol: now.protocol_version, pid: running[0], command }))
  assert.ok(command.startsWith(path.join(bundle, 'Contents/MacOS/kybernd')), 'the bundled kybernd took over')
  assert.equal(now.version, readFileSync(path.join(bundle, 'Contents/Resources/version'), 'utf8').trim())
  await app.app.getByText('No projects yet. Add a folder to see its threads here.').waitFor({ timeoutMs: 20_000 }).catch(() => {})
  await Bun.sleep(1500)
  execFileSync('screencapture', ['-x', '-o', '-l', String(windowId(app.pid)), path.join(out, 'packaged-after-restart.png')])
  console.log('ok  packaged app restarted the incompatible daemon and connected to its bundled kybernd')
} finally {
  await app.close().catch(() => {})
  // Stop only this scratch daemon (the bundled one the app started here).
  for (const pid of (() => { try { return pids() } catch { return [] } })()) try { process.kill(pid, 'SIGINT') } catch {}
}
process.exit(0)
