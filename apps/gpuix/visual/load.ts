/**
 * Finds the per-area screen and fixture files so sibling agents can add screens
 * without touching the tool core:
 *
 *   visual/screens/<area>.gpuix.ts   exports `screens: Record<string, Step>`
 *   visual/screens/<area>.tauri.mjs  exports `screens: Record<string, (page) => Promise<void>>`
 *   visual/fixture.<area>.ts         exports `seed(client, ctx)` and optionally `ids(client)`
 *
 * A `.gpuix.ts` file may also export `entries: Record<screenName, { entry, env? }>`: that screen
 * launches `entry` (path relative to apps/gpuix, e.g. a fixture app) instead of `src/main.tsx`,
 * with `env` merged over the tool's launch env. Screens without an entry use `src/main.tsx`.
 *
 * `screens.gpuix.ts` / `screens.tauri.mjs` stay the Notes and Tasks screens.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { screens as baseScreens, type Fixture } from './screens.gpuix.ts'
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'

type Step = (typeof baseScreens)[string]
const dir = import.meta.dir

export type SeedContext = { state: { port: number; token: string }; scratch: string; projects: { id: string; name?: string; path?: string }[] }
export type AreaFixture = {
  seed?: (client: KybernClient, ctx: SeedContext) => Promise<void>
  ids?: (client: KybernClient) => Promise<Record<string, unknown>>
}

export async function loadGpuixScreens(): Promise<Record<string, Step>> {
  const all: Record<string, Step> = { ...baseScreens }
  const sub = path.join(dir, 'screens')
  for (const f of readdirSync(sub).filter((x) => x.endsWith('.gpuix.ts')).sort()) {
    const mod = await import(path.join(sub, f))
    for (const [name, step] of Object.entries(mod.screens ?? {})) {
      if (all[name]) throw new Error(`screen ${name} defined twice (${f})`)
      all[name] = step as Step
    }
  }
  for (const name of ['blur-dialog', 'blur-palette', 'blur-popover']) {
    all[`${name}-base`] = async (app, fx) => {
      await all[name]!(app, fx)
      await app.getByTestId('app-ready').press('escape')
      const { park } = await import('./screens.gpuix.ts')
      await park(app)
    }
  }
  all['tasks-hover'] = async (app, fx) => {
    await all['tasks-list']!(app, fx)
    await app.getByTestId(`task-row-${fx.tasks['Fix sidebar collapse jitter on resize']}`).hover()
    await new Promise(r => setTimeout(r, 500))
  }
  all['dock-tab-hover'] = async (app, fx) => {
    await all['dock-agents']!(app, fx)
    await app.getByTestId('dock-tab-agents').hover()
    await new Promise(r => setTimeout(r, 500))
  }
  all['dock-base'] = async (app, fx) => {
    const { click, park, settle } = await import('./screens.gpuix.ts')
    await click(app, `thread-${fx.extra.dock!.thread}`)
    if (!await app.getByTestId('dock-tabs').count()) await click(app, 'dock-toggle')
    await settle(600); await park(app)
  }
  return all
}

export type ScreenEntry = { entry: string; env?: Record<string, string> }

export async function loadGpuixEntries(): Promise<Record<string, ScreenEntry>> {
  const all: Record<string, ScreenEntry> = {}
  const sub = path.join(dir, 'screens')
  for (const f of readdirSync(sub).filter((x) => x.endsWith('.gpuix.ts')).sort()) {
    const mod = await import(path.join(sub, f))
    for (const [name, e] of Object.entries(mod.entries ?? {})) all[name] = e as ScreenEntry
  }
  for (const name of ['blur-dialog', 'blur-palette', 'blur-popover']) if (all[name]) all[`${name}-base`] = all[name]!
  return all
}

export async function loadAreaFixtures(): Promise<Record<string, AreaFixture>> {
  const out: Record<string, AreaFixture> = {}
  // Focused parity lanes can reuse a seeded daemon without unrelated RPC proxies.
  const areas = process.env.GPUIX_VISUAL_AREAS?.split(',')
  for (const f of readdirSync(dir).filter((x) => /^fixture\..+\.ts$/.test(x)).sort()) {
    if (areas && !areas.includes(f.slice('fixture.'.length, -'.ts'.length))) continue
    out[f.slice('fixture.'.length, -'.ts'.length)] = await import(path.join(dir, f))
  }
  return out
}

export type { Fixture }

export async function loadStateBases(): Promise<Record<string, string>> {
  const { stateBases } = await import('./state-bases.ts')
  const bases = { ...stateBases }
  for (const f of readdirSync(path.join(dir, 'screens')).filter(x => x.endsWith('.gpuix.ts')).sort()) {
    const mod = await import(path.join(dir, 'screens', f))
    Object.assign(bases, mod.bases ?? {})
  }
  return bases
}
