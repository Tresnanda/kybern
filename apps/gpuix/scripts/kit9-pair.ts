/**
 * Desktop-vs-GPUIX images of kit primitives, at the same logical size.
 *
 *   bun scripts/kit9-pair.ts <state ...> [--theme dark|light|both] [--reduced] [--out dir] [--tauri-only|--gpuix-only] [--vite 5791]
 *
 * States come from `visual/kit/steps`. The desktop side is `visual/kit/gallery.tsx` in WebKit (a Vite server started
 * here from `apps/desktop` if none answers on --vite); the GPUIX side is `scripts/kit9-gallery-entry.tsx`.
 * Writes <out>/kit-<state>-<theme>-{tauri,gpuix,pair,diff}.png (Tauri left, GPUIX right in pair).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../native/frame-harness.ts'
import { states } from '../visual/kit/steps/index.ts'

process.env.PLAYWRIGHT_CORE ??= '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs'
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const valueArgs = new Set(['--theme', '--out', '--vite'])
const wanted = args.filter((a, i) => !a.startsWith('--') && !valueArgs.has(args[i - 1] ?? ''))
const names = wanted.length ? wanted : Object.keys(states)
for (const n of names) if (!states[n]) throw new Error(`Unknown state ${n}. Known: ${Object.keys(states).join(', ')}`)
const themeArg = opt('theme') ?? 'dark'
const themes = themeArg === 'both' ? ['dark', 'light'] : [themeArg]
const out = opt('out') ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/kit'
const vite = Number(opt('vite') ?? 5791)
const reduced = flag('reduced')
const here = import.meta.dir
const desktop = path.resolve(here, '../../desktop')
mkdirSync(out, { recursive: true })

async function ensureVite() {
  try { if ((await fetch(`http://127.0.0.1:${vite}/gallery.html`, { signal: AbortSignal.timeout(1500) })).ok) return } catch {}
  // rolldown would load GPUIX's .node if the brief's NAPI variable leaked through.
  const { NAPI_RS_NATIVE_LIBRARY_PATH: _n, ...env } = process.env
  const child = spawn('pnpm', ['exec', 'vite', '--config', '../gpuix/visual/kit/vite.config.ts', '--host', '127.0.0.1', '--port', String(vite), '--strictPort'], { cwd: desktop, env, stdio: 'ignore', detached: true })
  child.unref()
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${vite}/gallery.html`)).ok) return } catch {} await Bun.sleep(200) }
  throw new Error('gallery Vite server did not start')
}

for (const theme of themes) {
  if (!flag('gpuix-only')) {
    await ensureVite()
    const spec = JSON.stringify({ vite, theme, reduced, out, states: names })
    const r = spawnSync('node', [path.join(here, 'kit9-gallery-tauri.mjs'), spec], { stdio: 'inherit', env: process.env })
    if (r.status !== 0) throw new Error('desktop capture failed')
  }
  if (flag('tauri-only')) continue
  for (const name of names) {
    const state = states[name]!
    const env = { KIT_SECTION: state.section, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1', ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : { KYBERN_REDUCED_MOTION: '0' }), KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/phase2-kit9-client' }
    const f = await launchFixture(path.join(here, 'kit9-gallery-entry.tsx'), env)
    try {
      await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
      await Bun.sleep(400)
      if (state.gpuix) await state.gpuix(f.app)
      await Bun.sleep(state.settle ?? 500)
      const base = path.join(out, `kit-${name}-${theme}`)
      await f.app.screenshot({ path: `${base}-gpuix-full.png` })
      const clip = state.clip
      if (clip) spawnSync('swift', [path.join(here, 'kit9-crop.swift'), `${base}-gpuix-full.png`, `${base}-gpuix.png`, String(clip[0] * 2), String(clip[1] * 2), String(clip[2] * 2), String(clip[3] * 2)])
      else spawnSync('cp', [`${base}-gpuix-full.png`, `${base}-gpuix.png`])
      spawnSync('rm', ['-f', `${base}-gpuix-full.png`])
      if (!flag('gpuix-only')) {
        const c = spawnSync('swift', [path.join(desktop, '../gpuix/visual/compose.swift'), `${base}-tauri.png`, `${base}-gpuix.png`, `${base}-pair.png`, `${base}-diff.png`], { encoding: 'utf8' })
        console.log(`[kit pair] ${name} ${theme}${reduced ? ' reduced' : ''}: ${c.stdout.trim().split('\n').pop() ?? ''}`)
      }
    } finally { await f.close() }
  }
}
