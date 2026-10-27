// What the first-run flow actually presented on every step change, frame by frame. The addon's `KYBERN_PRESENT_DUMP` (the fork's
// Metal renderer) writes each presented drawable to a PNG at half size; the automation screenshot cannot show this (it renders a
// fresh frame). Then every transition is scanned for flashes: pixels that leave where they were and come back within 1–3 frames
// (a hidden element or the other scene showing for a frame), which a cross-fade never does.
//   bun scripts/onboarding-present-dump.ts <label> [--theme dark|light] [--strips <dir>] [--analyze]
// `--analyze` re-reads a recorded run of that label instead of recording one.
// Starts its own scratch daemon (BENCH_SCRATCH, BENCH_PORT, default 4391) and stops every daemon serving its data dir at the end.
// Other KYBERN_* variables pass through (KYBERN_NESTED_SCOPE_REPLAY=0 is the native A/B control).
import '../src/native/local-build.ts'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pixels } from '../native/png.ts'
import { launchFixture } from '../src/requests/harness.ts'

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const label = process.argv[2] ?? 'run'
const theme = arg('--theme', 'dark')
const strips = process.argv.includes('--strips') ? arg('--strips', '') : null
const repo = path.resolve(import.meta.dir, '../../..')
const dir = path.join(process.env.BENCH_SCRATCH ?? path.join(tmpdir(), 'kybern-onboarding-bench'), `present-${label}-${theme}`)
const data = path.join(dir, 'data')
const frames = path.join(dir, 'frames')
const port = Number(process.env.BENCH_PORT ?? 4391)
const kybernd = path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, 'target'), 'debug', 'kybernd')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const analyze = process.argv.includes('--analyze')
if (!analyze) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(data, { recursive: true }); mkdirSync(frames, { recursive: true })
}

/** Every daemon serving the data dir: the one started here and any the window started for it (they outlive the window). */
function stopDaemons() {
  spawnSync('pkill', ['-f', `kybernd.*${data}`])
  if (spawnSync('pgrep', ['-f', `kybernd.*${data}`]).status === 0) spawnSync('pkill', ['-9', '-f', `kybernd.*${data}`])
}
/** Presented frames so far, in present order. */
const list = () => readdirSync(frames).filter((f) => f.endsWith('.png')).sort()
const lastFrame = () => { const all = list(); return all.length ? Number(all[all.length - 1]!.slice(0, 6)) : -1 }
interface Transition { name: string; from: number; to: number }
const transitions: Transition[] = []

if (analyze) transitions.push(...JSON.parse(readFileSync(path.join(dir, 'transitions.json'), 'utf8')) as Transition[])
else await record()

async function record() {
  const env = { ...process.env }; delete env.KYBERN_URL; delete env.KYBERN_TOKEN
  const daemon = spawn(kybernd, ['--data-dir', data, '--port', String(port)], { env, stdio: 'ignore' })
  for (let i = 0; i < 100 && !existsSync(path.join(data, 'daemon.port')); i++) await sleep(100)
  await sleep(300)

  let f: Awaited<ReturnType<typeof launchFixture>>
  try {
    f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
      GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_WINDOW_SIZE: '1440x900', KYBERN_ONBOARDING: '1', KYBERN_PRESENT_DUMP: frames,
      KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(dir, 'credentials'), KYBERN_URL: '', KYBERN_TOKEN: '',
    })
  } catch (error) {
    daemon.kill(); stopDaemons()
    throw error
  }
  try {
    const a = f.app
    const has = async (id: string) => { try { return (await a.getByTestId(id).count()) > 0 } catch { return false } }
    const until = async (id: string, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await has(id)) return true; await sleep(50) } return false }
    const step = async (name: string, id: string, settle = 1800) => {
      if (!await until(id, 8000)) throw new Error(`${id} is not on screen (${name})`)
      const c = await a.getByTestId(id).center()
      await sleep(150)
      const from = lastFrame() + 1
      await a.mouse.click(c)
      await sleep(settle)
      transitions.push({ name, from, to: lastFrame() })
    }
    if (!await until('onboarding-start', 60000)) throw new Error('the hero never appeared')
    await sleep(3000)
    await step('hero→agents', 'onboarding-start')
    await sleep(2500)
    await step('agents→hero (Back)', 'agents-back')
    await sleep(1000)
    await step('hero→agents', 'onboarding-start')
    await until('agents-continue'); await sleep(3000)
    await step('agents→projects', 'agents-continue')
    await sleep(2500)
    await step('projects→agents (Back)', 'projects-back')
    await sleep(1500)
    await step('agents→projects', 'agents-continue')
    await sleep(2500)
    // The first press imports (when the scan found chats), the second moves on.
    await a.mouse.click(await a.getByTestId('projects-primary').center())
    await sleep(4000)
    await step('projects→prefs', 'projects-primary')
    await sleep(1500)
    await step('prefs→projects (Back)', 'onboarding-prefs-back')
    await sleep(1500)
    await step('projects→prefs', 'projects-primary')
    await sleep(1500)
    await step('prefs→app', 'onboarding-done', 3000)
    await sleep(500)
  } finally {
    await f.close(); daemon.kill(); stopDaemons()
  }
  writeFileSync(path.join(dir, 'transitions.json'), JSON.stringify(transitions))
  await sleep(500)
}

/**
 * A frame as the mean RGB of 8×8 blocks (16 × 16 device pixels): an edge sliding through a pixel during a rise averages out,
 * an element or a scene changing opacity does not.
 */
const BLOCK = 8
const load = (file: string) => {
  const p = pixels(path.join(frames, file)), bw = Math.floor(p.w / BLOCK), bh = Math.floor(p.h / BLOCK), out = new Float32Array(bw * bh * 3)
  for (let y = 0; y < bh * BLOCK; y++) for (let x = 0; x < bw * BLOCK; x++) {
    const at = (y * p.w + x) * p.channels, k = (Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)) * 3
    out[k] += p.data[at]!; out[k + 1] += p.data[at + 1]!; out[k + 2] += p.data[at + 2]!
  }
  for (let k = 0; k < out.length; k++) out[k] /= BLOCK * BLOCK
  return out
}
/**
 * Flash blocks starting at frame `i`: the run i..i+w-1 (w ≤ 3) sits more than 12 levels away from the frames on both sides,
 * which agree with each other within 6. A fade moves a block a few levels per frame and never comes back.
 */
function flashes(seq: Float32Array[], i: number) {
  let best = 0
  for (let w = 1; w <= 3 && i + w < seq.length; w++) {
    const before = seq[i - 1]!, after = seq[i + w]!
    let n = 0
    for (let p = 0; p < before.length; p += 3) {
      let back = 0, away = 255
      for (let c = 0; c < 3; c++) back = Math.max(back, Math.abs(before[p + c]! - after[p + c]!))
      if (back > 6) continue
      for (let k = i; k < i + w; k++) { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(seq[k]![p + c]! - before[p + c]!)); away = Math.min(away, d) }
      if (away > 12) n++
    }
    best = Math.max(best, n)
  }
  return best
}

const all = list()
const report = transitions.map((t, index) => {
  const files = all.filter((file) => { const n = Number(file.slice(0, 6)); return n >= t.from - 1 && n <= t.to })
  const seq = files.map(load)
  const counts = files.map((_, i) => (i === 0 || i === files.length - 1 ? 0 : flashes(seq, i)))
  const worst = counts.indexOf(Math.max(0, ...counts))
  if (strips && files.length) {
    mkdirSync(strips, { recursive: true })
    const slug = `${String(index + 1).padStart(2, '0')}-${t.name.replace(/[^a-z]+/gi, '-').replace(/-+$/, '').toLowerCase()}`
    const centre = counts[worst]! > 0 ? worst : Math.min(files.length - 1, 4)
    for (let k = Math.max(0, centre - 2); k <= Math.min(files.length - 1, centre + 2); k++)
      copyFileSync(path.join(frames, files[k]!), path.join(strips, `5x-${label}-${theme}-${slug}-f${files[k]!.slice(0, 6)}.png`))
  }
  return { name: t.name, frames: files.length, flashFrames: counts.filter((n) => n > 2).length, worst: { frame: files[worst], blocks: counts[worst] }, counts }
})
writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1))
console.log(`transition | presented frames | frames with a flash (>2 blocks of 16×16 px) | worst frame (flash blocks)`)
for (const r of report) console.log(`${r.name} | ${r.frames} | ${r.flashFrames} | ${r.worst.frame} (${r.worst.blocks})`)
console.log(`frames: ${frames}`)
