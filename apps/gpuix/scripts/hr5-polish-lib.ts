/** Shared helpers for the hands-on round 5 polish checks (empty states, mention menu, narrow composer). */
import { mkdirSync } from 'node:fs'
import { SEEDED, start, waitUntil, windowFrame, type App } from './kit9-lib.ts'
import { connect, readState } from '../visual/fixture.ts'

export const OUT = '/Users/mymac/projects/ade/previews/gpuix/handson-r5/polish'
mkdirSync(OUT, { recursive: true })
export { waitUntil, type App }

export async function threadId(title: string) {
  const client = await connect(readState()!)
  const { threads } = await client.call('threads.list', {})
  client.close?.()
  const thread = threads.find((t) => t.title === title)
  if (!thread) throw Error(`No scratch thread ${title}`)
  return thread.id
}

export interface LaunchOptions { theme: 'dark' | 'light'; size?: string; thread?: string; reduced?: boolean; env?: Record<string, string>; sidebar?: number; ui?: Record<string, unknown> }

/** One GPUIX window on the hidden test display against the scratch daemon, with a clean saved layout. */
export async function launch(options: LaunchOptions) {
  Bun.spawnSync(['sh', '-c', `rm -f '${SEEDED.dataDir}/gpuix-ui.json' '${SEEDED.clientDir}'/workspace-*.json`])
  if (options.sidebar || options.ui) await Bun.write(`${SEEDED.dataDir}/gpuix-ui.json`, JSON.stringify({ ...(options.sidebar ? { 'kybern.sidebar.width': options.sidebar } : {}), ...options.ui }))
  const thread = options.thread ? await threadId(options.thread) : undefined
  const app = await start({
    light: options.theme === 'light',
    reduced: options.reduced ?? true,
    seeded: true,
    size: options.size ?? '1280x820',
    env: { ...(thread ? { KYBERN_GPUIX_THREAD: thread } : {}), ...options.env },
  })
  return app
}

/** Window must be on the hidden display (CG x < 0, y >= 900) before any capture is kept. */
export function onTestDisplay(pid: number) {
  const out = Bun.spawnSync(['swift', '/Users/mymac/projects/ade-gpuix-scratch/window-onscreen.swift', String(pid)]).stdout.toString()
  const match = [...out.matchAll(/X = "?(-?[\d.]+)"?;\s*Y = "?(-?[\d.]+)"?;/g)]
  return match.length > 0 && match.every((m) => Number(m[1]) < 0 && Number(m[2]) >= 900) ? true : (console.log(out), false)
}
