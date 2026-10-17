// Accounts page right after launch, with provider statuses / accounts held back by a delay proxy (polish9 item 2).
//   bun scripts/polish9-accounts-check.ts <name> '<method=ms,...>' [clickDelayMs]
// Opens Settings → Accounts as soon as the rail is there and captures it at +0.5 s, +2 s and +4 s. Scratch daemon only.
import { launch } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { assertScratchEnv } from '../src/requests/harness.ts'

const [name = 'run', spec = '', clickDelay = '0'] = process.argv.slice(2)
const scratch = '/Users/mymac/projects/ade-gpuix-scratch/phase2-polish9'
const daemonPort = Number(process.env.POLISH9_DAEMON_PORT ?? 4307)
const token = readFileSync(path.join(scratch, 'daemon.token'), 'utf8').trim()
const out = process.env.POLISH9_OUT ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/polish9/accounts'
mkdirSync(out, { recursive: true })
const theme = process.env.KYBERN_APPEARANCE ?? 'dark'
const proxy = spawn('bun', [path.resolve(import.meta.dir, 'polish9-delay-proxy.ts'), String(daemonPort), token, spec], { stdio: ['ignore', 'pipe', 'inherit'] })
const proxyPort = await new Promise<number>((resolve, reject) => { proxy.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))); proxy.once('exit', () => reject(new Error('proxy exited'))) })
const env = { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_URL: `ws://127.0.0.1:${proxyPort}/ws`, KYBERN_TOKEN: token, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: `${scratch}-client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${scratch}-creds`, KYBERN_REDUCED_MOTION: '1', KYBERN_ENVIRONMENT_NAME: 'Development environment' }
assertScratchEnv(env)
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../src/main.tsx')], env })
const t0 = Date.now()
const flags = async () => { const text = (await app.call('getPaintedText', {})).text.join(' | '); return `${text.includes('Sign in to more than one account') ? 'H' : '-'}${text.includes('Claude Code') ? 'C' : '-'}${text.includes('Codex') ? 'X' : '-'}${text.includes('isn’t installed') || text.includes('aren’t installed') ? 'M' : '-'}` }
const shot = async (label: string) => { if (process.env.POLISH9_QUIET) { process.stdout.write(`${await flags()} `); return } await app.screenshot({ path: `${out}/accounts-${name}-${theme}-${label}.png` }); console.log(name, label, `${Date.now() - t0}ms`, (await app.call('getPaintedText', {})).text.join(' | ')) }
try {
  await app.getByTestId('rail-settings').waitFor({ timeoutMs: 60_000 })
  await Bun.sleep(Number(clickDelay))
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-tab-accounts').waitFor({ timeoutMs: 20_000 })
  await app.getByTestId('settings-tab-accounts').click()
  if (process.env.POLISH9_BURST) { for (let i = 0; i < 14; i++) { await shot(`burst-${String(i).padStart(2, '0')}`); await Bun.sleep(Number(process.env.POLISH9_BURST)) } }
  else { await Bun.sleep(500); await shot('a-0.5s'); await Bun.sleep(1500); await shot('b-2s'); await Bun.sleep(2000); await shot('c-4s') }
} finally { await app.close(); proxy.kill() }
