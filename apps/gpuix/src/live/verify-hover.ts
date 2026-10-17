/**
 * Idle cost of resting the pointer on the live view's controls (the mini player's header once flapped
 * between hovered and not at 60 Hz, because the revealed controls take the pointer from the card).
 * Scene submissions per 200 ms (KYBERN_FRAME_TIMES) while the pointer rests on the card body, then on
 * the controls. Uses the visual-pair scratch daemon (never ~/.kybern) and the recorded-frame fixture
 * (`scripts/dock2-fixture.tsx`, DOCK2_LIVE=1), so there is no real CuaDriver frame.
 *
 *   bun src/live/verify-hover.ts [dark|light] [reduced]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, connect, seed, startDaemon, stopPid } from '../../visual/fixture.ts'
import { loadAreaFixtures } from '../../visual/load.ts'

const [theme = 'dark', motion] = process.argv.slice(2)
if (!DATA_DIR.includes('gpuix-scratch')) throw new Error('Not a scratch data dir')
let state = await startDaemon(true)
if (!state.seeded) await seed(state)
const client = await connect(state)
const extra: Record<string, Record<string, unknown>> = {}
for (const [area, f] of Object.entries(await loadAreaFixtures())) if (f.ids) extra[area] = await f.ids(client) as Record<string, unknown>
const thread = extra.dock!.thread as string
client.close?.()
const trace = '/tmp/claude-501/live-hover.trace'
writeFileSync(trace, '')
const child = spawn('bun', [path.resolve(import.meta.dir, '../../scripts/dock2-fixture.tsx')], { stdio: ['pipe', 'pipe', 'pipe'], env: {
  ...process.env, DOCK2_LIVE: '1', GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_FRAME_TIMES: '1', KYBERN_FULL_RATE: '1', KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR,
  KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_REDUCED_MOTION: motion === 'reduced' ? '1' : '0', KYBERN_WINDOW_SIZE: '1280x820',
} })
child.stderr.on('data', chunk => appendFileSync(trace, chunk))
const app = await connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => child.stdout.on('data', chunk => listener(String(chunk))), close: async () => { child.kill() } })
const mark = (label: string) => appendFileSync(trace, `[mark] ${label}\n`)
const frames = (label: string) => {
  const lines = readFileSync(trace, 'utf8').split('\n'), start = lines.indexOf(`[mark] ${label}`), times: number[] = []
  for (const line of lines.slice(start + 1)) { if (line.startsWith('[mark]')) break; const m = /\[kybern-frame\] ([\d.]+)/.exec(line); if (m) times.push(Number(m[1])) }
  return times
}
const per200 = (label: string) => { const f = frames(label); return f.length ? Array.from({ length: 6 }, (_, i) => f.filter(t => t >= f[0]! + i * 200 && t < f[0]! + (i + 1) * 200).length) : [] }
const result: Record<string, unknown> = { theme, reducedMotion: motion === 'reduced', fullRate: 1, fixture: 'recorded frame (no CuaDriver)' }
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await Bun.sleep(1500)
  await app.getByTestId(`thread-${thread}`).click()
  await app.getByTestId('computer-live-image').waitFor({ timeoutMs: 20_000 }); await Bun.sleep(2500)
  const b = await app.getByTestId('computer-live').bounds()
  mark('body'); await app.mouse.move({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); await Bun.sleep(1300)
  mark('controls'); await app.mouse.move({ x: b.x + b.width - 24, y: b.y + 22 }); await Bun.sleep(1300)
  mark('away'); await app.mouse.move({ x: 20, y: 20 }); await Bun.sleep(1000)
  mark('end')
  result.bodyHoverFramesPer200ms = per200('body'); result.controlsHoverFramesPer200ms = per200('controls'); result.leaveFramesPer200ms = per200('away')
  console.log(JSON.stringify(result))
} finally { await app.close(); if (child.exitCode === null) child.kill(); stopPid(state.daemonPid) }
process.exit(0)
