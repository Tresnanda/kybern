/**
 * Capture tween frames for the thread panel, title bar, rail and overlays
 * (`src/sidebar/motion.tsx`, `nav/overlay.tsx`). Each step pauses the native
 * clock, triggers the change, and writes frames at fixed offsets.
 *
 *   KYBERN_DATA_DIR=<scratch> bun scripts/sidebar-motion.ts <out-dir> [--only=a,b] [--writes]
 *
 * `--writes` adds the steps that change the daemon (rename); scratch daemon only.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'

function forwarded(): Record<string, string> {
  const keys = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--')) ?? 'screenshots/sidebar-motion'
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const writes = args.includes('--writes')
const PROJECT = process.env.MOTION_PROJECT ?? '01a13a8f-a689-7881-a6a7-171a0da14a4a'
const THREAD = process.env.MOTION_THREAD ?? '01a13abe-29eb-7343-a68e-119280db2686'
mkdirSync(out, { recursive: true })

const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', ...forwarded() },
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const keys = (k: string) => app.call('keystrokes', { keys: k } as never)
const moveAway = () => app.mouse.move({ x: 1200, y: 760 })
const frames = (name: string, at: number, offsets: number[]) =>
  app.captureFrames(
    path.join(out, name),
    offsets.map((o) => at + o),
  )
const step = async (name: string, run: (app: App) => Promise<void>) => {
  if (only && !only.includes(name)) return
  try {
    await run(app)
    console.log(`[motion] ${name}`)
  } catch (error) {
    console.log(`[motion] ${name} failed: ${error instanceof Error ? error.message : error}`)
  }
  await app.clock.resume().catch(() => {})
  await keys('escape').catch(() => {})
  await moveAway()
  await sleep(300)
}
/** Pause, act, let the event land, capture at offsets from the pause. */
const capture = async (name: string, act: () => Promise<unknown>, offsets: number[], settle = 120) => {
  const at = await app.clock.pause()
  await act()
  await sleep(settle)
  await frames(name, at, offsets)
  await app.clock.resume()
}

await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await sleep(2500)
await moveAway()
await sleep(100)

await step('project', async () => {
  await app.getByTestId(`project-${PROJECT}`).hover()
  await sleep(300)
  await capture('project-close', () => app.getByTestId(`project-toggle-${PROJECT}`).click(), [0, 40, 80, 120, 180, 260])
  await sleep(300)
  await capture('project-open', () => app.getByTestId(`project-toggle-${PROJECT}`).click(), [0, 40, 80, 120, 180, 260])
})

await step('more', async () => {
  await capture('more-open', () => app.getByTestId(`more-${PROJECT}`).click(), [0, 40, 80, 120, 180, 260])
  await sleep(300)
  await capture('more-close', () => app.getByTestId(`more-${PROJECT}`).click(), [0, 40, 80, 120, 180, 260])
})

await step('reveal', async () => {
  await capture('reveal-thread', () => app.getByTestId(`thread-${THREAD}`).hover(), [0, 30, 60, 100, 170], 80)
  await moveAway()
  await sleep(200)
  await capture('reveal-project', () => app.getByTestId(`project-${PROJECT}`).hover(), [0, 30, 60, 100, 170], 80)
})

await step('context-menu', async () => {
  await capture('context-menu', () => app.getByTestId(`thread-${THREAD}`).click({ button: 2 }), [0, 50, 100, 160, 280])
})

await step('app-menu', async () => {
  await capture('app-menu', () => app.getByTestId('app-menu').click(), [0, 50, 100, 160, 280])
})

await step('app-menu-early', async () => {
  await capture('app-menu-early', () => app.getByTestId('app-menu').click(), [0, 8, 16, 24, 32, 48])
})

await step('filter-menu', async () => {
  await app.getByText('Projects').hover()
  await sleep(300)
  await capture('filter-menu', () => app.getByTestId('sidebar-filter').click(), [0, 50, 100, 160, 280])
})

await step('tooltip', async () => {
  await app.getByTestId('sidebar-search').hover()
  await sleep(350)
  const at = await app.clock.pause()
  await sleep(500) // the tooltip's 600 ms delay passes in real time
  await frames('tooltip', at, [0, 40, 80, 160])
  await app.clock.resume()
})

await step('palette-pointer', async () => {
  await capture('palette-pointer', () => app.getByTestId('sidebar-search').click(), [0, 50, 100, 160, 280])
})

await step('palette-key', async () => {
  await capture('palette-key', () => keys('cmd-k'), [0, 50, 160])
})

await step('panel-swap', async () => {
  await capture('panel-swap-close', () => app.getByTestId('sidebar-toggle').click(), [0, 50, 100, 160, 280])
  await sleep(300)
  await capture('panel-swap-open', () => app.getByTestId('sidebar-toggle').click(), [0, 50, 100, 160, 280])
})

await step('thread-menu', async () => {
  await app.getByTestId(`thread-${THREAD}`).click()
  await sleep(1200)
  await capture('thread-actions', () => app.getByTestId('thread-actions').click(), [0, 50, 100, 160, 280])
})

await step('rename', async () => {
  if (!writes) return
  await app.getByTestId(`thread-${THREAD}`).click()
  await sleep(1000)
  const before = await app.getByTestId('header-title').textContent()
  await app.getByTestId('thread-actions').click()
  await sleep(200)
  await app.getByText('Rename thread').click()
  await sleep(200)
  await app.getByTestId('header-rename').fill(before.includes('again') ? 'Renamed by sidebar test' : 'Renamed by sidebar test again')
  await capture('title-swap', () => keys('enter'), [0, 50, 100, 160, 280], 400)
})

await step('new-thread', async () => {
  if (!writes || !process.env.KYBERN_DATA_DIR) return
  const cli = process.env.KYBERN_CLI ?? '/Applications/kybern.app/Contents/MacOS/kybern'
  const project = process.env.MOTION_NEW_PROJECT ?? '01a13a95-37e2-7501-b7ca-57837d6ead6b'
  await capture(
    'new-thread',
    async () => {
      const proc = Bun.spawn([cli, '--data-dir', process.env.KYBERN_DATA_DIR!, 'new', '--project', project, '--model', 'claude-haiku-5-5', '--detach', 'Reply with ok'])
      await proc.exited
    },
    [0, 40, 80, 140, 260],
    900,
  )
})

/** Test ids in the painted tree that start with `prefix`. */
async function testIds(prefix: string): Promise<string[]> {
  const { tree } = (await app.call('getTree', {} as never)) as { tree: { testId?: string; children?: unknown[] } | null }
  const found: string[] = []
  const walk = (node: { testId?: string; children?: unknown[] } | null) => {
    if (!node) return
    if (node.testId?.startsWith(prefix)) found.push(node.testId)
    for (const child of node.children ?? []) walk(child as typeof node)
  }
  walk(tree)
  return found
}
async function waitFor(prefix: string, timeoutMs: number, poll = 100): Promise<string | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const ids = await testIds(prefix)
    if (ids.length) return ids[0]!
    await sleep(poll)
  }
  return null
}

// A live subagent (scratch daemon, tiny haiku prompt): collapse and expand its
// parent's nested rows, then the check-then-leave exit when it finishes.
await step('subagent', async () => {
  if (!writes || !process.env.KYBERN_DATA_DIR) return
  const cli = process.env.KYBERN_CLI ?? '/Applications/kybern.app/Contents/MacOS/kybern'
  const project = process.env.MOTION_NEW_PROJECT ?? '01a13a95-37e2-7501-b7ca-57837d6ead6b'
  const prompt = "Use the Task tool exactly once to launch one general-purpose subagent with this prompt: 'Without using any tools, write a 200 word poem about rivers.' Then reply done."
  Bun.spawn([cli, '--data-dir', process.env.KYBERN_DATA_DIR, 'new', '--project', project, '--model', 'claude-haiku-5-5', '--detach', prompt])
  const child = await waitFor('child-', 120_000)
  if (!child) throw new Error('no child row appeared')
  const childId = child.slice('child-'.length)
  const toggle = await waitFor('children-', 2_000)
  if (toggle) {
    await capture('children-close', () => app.getByTestId(toggle).click(), [0, 40, 80, 140, 240])
    await sleep(250)
    await capture('children-open', () => app.getByTestId(toggle).click(), [0, 40, 80, 140, 240])
    await moveAway()
  }
  // Finished: it holds its check for 600 ms (a JS timer), then leaves. The painted
  // tree only updates while the clock runs, so catch the leave as soon as it shows
  // and capture the rest of its 200 ms from there.
  const done = await waitFor(`child-result-${childId}`, 180_000, 30)
  if (!done) throw new Error('the row did not finish')
  const leaving = await waitFor(`leaving-${childId}`, 10_000, 10)
  if (!leaving) throw new Error('the row did not leave')
  const at = await app.clock.pause()
  await frames('subagent-leave', at, [0, 30, 60, 100, 160, 240])
  await app.clock.resume()
})

await step('page', async () => {
  await capture('page-usage', () => app.getByTestId('rail-usage').click(), [0, 50, 100, 160, 280])
  await sleep(200)
  await app.getByTestId('rail-home').click()
})

await step('hover-card', async () => {
  const ring = app.getByTestId('rail-usage-claude-code')
  if ((await ring.count()) === 0) throw new Error('no usage ring')
  await capture('hover-card', () => ring.hover(), [0, 50, 100, 160, 280], 200)
})

await app.close()
console.log('[motion] done')
