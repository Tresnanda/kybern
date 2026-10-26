/**
 * The WP1 facts a `gpuix-platforms.yml` job must prove, read back from the checks' JSON reports (the checks assert them
 * too; this step names each one on the run page and fails when a report is missing).
 *
 *   bun scripts/assert-platform-reports.ts linux|linux-wayland|windows
 *
 * A run whose folder is absent (not selected with `checks`) is listed as not run, not failed.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const job = process.argv[2] ?? ''
const root = path.resolve(import.meta.dir, '..')
type Report = Record<string, any>
type Fact = { label: string; run: string; file: string; test: (report: Report) => string | null }

const ok = (condition: boolean, detail: string) => (condition ? null : detail)
const passed: Fact['test'] = (r) => ok(r.ok === true, `failures: ${(r.failures ?? []).join('; ') || 'none listed'}`)
const scroll: Fact['test'] = (r) => !r.bridged ? null : ok(typeof r.appWaitedPerFrame === 'number' && r.appWaitedPerFrame < 0.5, `appWaitedPerFrame ${r.appWaitedPerFrame} (${r.appWaited} over ${r.frames} frames)`)

const facts: Record<string, Fact[]> = {
  linux: [
    { label: 'X11: frame-wake passes (no per-frame JS wakes, exit wake, repaint at both parities)', run: 'gpuix-checks/frame-wake', file: 'gpuix-checks/frame-wake/frame-wake-x11.json', test: (r) => passed(r) ?? ok(r.platform === 'X11', `platform ${r.platform}`) },
    { label: 'X11: the KYBERN_FULL_INVALIDATE=1 control passes', run: 'gpuix-checks/frame-wake-full', file: 'gpuix-checks/frame-wake-full/frame-wake-x11.json', test: passed },
    { label: 'Stale WAYLAND_DISPLAY: GPUI fell back to X11', run: 'gpuix-checks-stale-wayland/frame-wake', file: 'gpuix-checks-stale-wayland/frame-wake/frame-wake-x11.json', test: (r) => passed(r) ?? ok(r.platform === 'X11' && r.info?.seat == null, `platform ${r.platform}, seat ${r.info?.seat}`) },
    { label: 'Transcript scroll: < 0.5 waited bridge calls per frame', run: 'gpuix-checks/smoke-clip-1', file: 'gpuix-checks/smoke-clip-1/scroll.json', test: scroll },
  ],
  'linux-wayland': [
    { label: 'Wayland without a wl_seat: frame-wake passes, seat is false', run: 'gpuix-checks/frame-wake', file: 'gpuix-checks/frame-wake/frame-wake-wayland.json', test: (r) => passed(r) ?? ok(r.platform === 'Wayland' && r.info?.seat === false, `platform ${r.platform}, seat ${r.info?.seat}`) },
    { label: 'Transcript scroll: < 0.5 waited bridge calls per frame', run: 'gpuix-checks/smoke-clip-1', file: 'gpuix-checks/smoke-clip-1/scroll.json', test: scroll },
  ],
  windows: [
    { label: 'Windows: frame-wake passes', run: 'gpuix-checks/frame-wake', file: 'gpuix-checks/frame-wake/frame-wake-windows.json', test: passed },
    { label: 'Windows: the KYBERN_FULL_INVALIDATE=1 control passes', run: 'gpuix-checks/frame-wake-full', file: 'gpuix-checks/frame-wake-full/frame-wake-windows.json', test: passed },
    {
      label: 'Windows: per-monitor-v2 DPI, windowDpi > 0, scaleFactor ≈ windowDpi / 96', run: 'gpuix-checks/frame-wake', file: 'gpuix-checks/frame-wake/frame-wake-windows.json',
      test: (r) => {
        const w = r.info?.windows, scale = r.info?.scaleFactor
        if (!w) return 'no info.windows'
        return ok(String(w.dpiMode).endsWith('per-monitor-v2') && w.windowDpi > 0 && Math.abs(scale - w.windowDpi / 96) <= 0.01, `dpiMode ${w.dpiMode} (source ${w.dpiSource}), windowDpi ${w.windowDpi}, scaleFactor ${scale}`)
      },
    },
    { label: 'Transcript scroll: < 0.5 waited bridge calls per frame', run: 'gpuix-checks/smoke-clip-1', file: 'gpuix-checks/smoke-clip-1/scroll.json', test: scroll },
  ],
}

const list = facts[job]
if (!list) throw new Error(`unknown job "${job}"; known: ${Object.keys(facts).join(', ')}`)
let failed = false
const lines = [`## WP1 platform reports: ${job}`, '', '| Fact | Result |', '| --- | --- |']
for (const fact of list) {
  let status: string
  if (!existsSync(path.join(root, fact.run))) status = 'not run'
  else if (!existsSync(path.join(root, fact.file))) { status = `**missing** ${fact.file}`; failed = true }
  else {
    const problem = fact.test(JSON.parse(readFileSync(path.join(root, fact.file), 'utf8')) as Report)
    status = problem ? `**fail**: ${problem}` : 'pass'
    failed ||= !!problem
  }
  lines.push(`| ${fact.label} | ${status.replaceAll('|', '\\|')} |`)
}
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n\n')
process.exit(failed ? 1 : 0)
