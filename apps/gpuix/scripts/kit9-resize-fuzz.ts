/**
 * Random-walk fuzz of every resize handle together with the things that change what is on screen while one is being
 * dragged (sidebar ⌘B, dock ⌘J, split ⌘\ and ⌘⇧\, page changes, key resizing of the dock). After each step: no error boundary,
 * nothing on the error channel. Seeded: `--seed N`, `--steps N`, `--size WxH`.
 *
 *   bun scripts/kit9-resize-fuzz.ts [--seed 1] [--steps 200] [--size 1000x700]
 */
import { SEEDED, start, type App } from './kit9-lib.ts'
const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1]! : d)
let seed = Number(arg('--seed', '1'))
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const steps = Number(arg('--steps', '200')), size = arg('--size', '1000x700')
const [W, H] = size.split('x').map(Number) as [number, number]
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
Bun.spawnSync(['rm', '-f', `${SEEDED.dataDir}/gpuix-ui.json`])
const app = await start({ seeded: true, size, env: { KYBERN_GPUIX_THREAD: 'Long review thread' } }) as App & { diagnostics: () => string; closeAll: () => Promise<void> }
const log: string[] = []
const bad = () => app.diagnostics().split('\n').find((l) => /\[error-boundary\]|panicked|RangeError|TypeError|Maximum update depth|Rendered (more|fewer) hooks|Unhandled|thread '.*' panicked/.test(l))
let failed = false
try {
  await app.getByTestId('sidebar-resize').waitFor({ timeoutMs: 30_000 }).catch(() => {})
  await sleep(1000)
  const handles = async () => { const out: { id: string; x: number; y: number; width: number; height: number }[] = []; const walk = (n: any) => { const id = n?.testId; if (id && (id === 'sidebar-resize' || id === 'dock-resize' || id.startsWith('split-resize-')) && n.bounds) out.push({ id, ...n.bounds }); n?.children?.forEach(walk) }; walk(((await app.call('getTree', {})) as any).tree); return out }
  const keys = ['cmd-b', 'cmd-j', 'cmd-\\', 'cmd-shift-\\']
  for (let i = 0; i < steps; i++) {
    const r = rand()
    let what = ''
    if (r < 0.55) {
      const hs = await handles()
      if (hs.length) {
        const h = hs[Math.floor(rand() * hs.length)]!
        const from = { x: h.x + h.width / 2, y: h.y + h.height / 2 }
        const n = 1 + Math.floor(rand() * 20)
        what = `drag ${h.id} ${n} steps`
        await app.mouse.move(from); await app.mouse.down(from)
        let at = from
        for (let k = 0; k < n; k++) {
          at = { x: Math.max(-50, Math.min(W + 80, at.x + (rand() - 0.5) * 400)), y: Math.max(-50, Math.min(H + 80, at.y + (rand() - 0.5) * 300)) }
          await app.mouse.move(at, { pressedButton: 0 })
          if (rand() < 0.3) await sleep(Math.floor(rand() * 20))
          if (rand() < 0.04) { // a shortcut mid-drag
            const k2 = keys[Math.floor(rand() * keys.length)]!
            what += ` +${k2}`; await app.getByTestId('app-ready').press(k2).catch(() => {})
          }
        }
        await app.mouse.up(at)
      }
    } else if (r < 0.8) { const k = keys[Math.floor(rand() * keys.length)]!; what = `key ${k}`; await app.getByTestId('app-ready').press(k).catch(() => {}); await sleep(Math.floor(rand() * 300)) }
    else if (r < 0.9) { const id = ['rail-home', 'rail-notes', 'rail-tasks', 'rail-pulls', 'rail-usage'][Math.floor(rand() * 5)]!; what = `page ${id}`; await app.getByTestId(id).click().catch(() => {}); await sleep(Math.floor(rand() * 300)) }
    else if (await app.getByTestId('dock-resize').count()) { const k = rand() < 0.5 ? 'left' : 'right'; what = `dock key ${k}`; await app.getByTestId('dock-resize').press(k).catch(() => {}) }
    log.push(`${i}: ${what}`)
    await sleep(40)
    const fallback = await app.getByTestId('error-fallback').count()
    const line = bad()
    if (fallback || line) { failed = true; console.log(`FAIL at step ${i} (${what}): ${fallback ? 'error boundary' : ''} ${line ?? ''}`); console.log(log.slice(-12).join('\n')); await app.screenshot({ path: `/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/resize-fuzz-failure-${size}-${arg('--seed', '1')}.png` }).catch(() => {}); break }
  }
  if (!failed) console.log(`PASS ${steps} steps, seed ${arg('--seed', '1')}, ${size}`)
} finally { await app.closeAll() }
process.exitCode = failed ? 1 : 0
