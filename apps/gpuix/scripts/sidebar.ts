/**
 * Drive the thread panel, title bar, rail and navigation in the live app and
 * write a screenshot per state. Read-only unless `--writes` is passed (pin,
 * rename, archive); run writes only against a scratch daemon.
 *
 *   KYBERN_DATA_DIR=<scratch> bun scripts/sidebar.ts <out-dir> [--light] [--writes] [--only=a,b]
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'

function forwarded(): Record<string, string> {
  const keys = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--')) ?? 'screenshots/sidebar'
const light = args.includes('--light')
const writes = args.includes('--writes')
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const suffix = light ? 'light' : 'dark'
mkdirSync(out, { recursive: true })

const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', ...forwarded() },
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shot = async (name: string) => {
  const file = path.join(out, `${name}-${suffix}.png`)
  await app.screenshot({ path: file })
  console.log(`[sidebar] ${file}`)
}
const keys = (k: string) => app.call('keystrokes', { keys: k } as never)
const moveAway = () => app.mouse.move({ x: 1200, y: 700 })
const step = async (name: string, run: (app: App) => Promise<void>) => {
  if (only && !only.includes(name)) return
  try {
    await run(app)
  } catch (error) {
    console.log(`[sidebar] ${name} failed: ${error instanceof Error ? error.message : error}`)
  }
  await keys('escape').catch(() => {})
  await moveAway()
  await sleep(200)
}

await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await sleep(2500)
// The first pointer event only places the cursor; later moves fire enter/leave.
await moveAway()
await sleep(100)

await step('panel', async () => {
  await shot('panel')
})

await step('show-more', async () => {
  const more = app.getByTestId('more-01a13a8f-a689-7881-a6a7-171a0da14a4a')
  await more.click()
  await sleep(400)
  await shot('show-more')
  if (!writes) {
    // "Show N more" is per mount, like the desktop: closing and reopening the panel resets it.
    await keys('cmd-b')
    await sleep(200)
    await keys('cmd-b')
    await sleep(400)
  }
})

await step('thread-hover', async () => {
  await app.getByTestId(`thread-${process.env.HANDOFF_ID ?? '01a13a95-3741-7cf2-8174-ba052f19efe4'}`).hover()
  await sleep(250)
  await shot('thread-hover')
})

await step('project-hover', async () => {
  const header = app.getByText('sidebar-two')
  await header.hover()
  await sleep(250)
  await shot('project-hover')
})

await step('thread-menu', async () => {
  await app.getByTestId(`thread-${process.env.HANDOFF_ID ?? '01a13a95-3741-7cf2-8174-ba052f19efe4'}`).click({ button: 2 })
  await sleep(250)
  await shot('thread-context-menu')
})

await step('project-menu', async () => {
  await app.getByText('sidebar-two').click({ button: 2 })
  await sleep(250)
  await shot('project-context-menu')
})

await step('app-menu', async () => {
  await app.getByTestId('app-menu').click()
  await sleep(250)
  await shot('app-menu')
})

await step('filter-menu', async () => {
  await app.getByText('Projects').hover()
  await sleep(150)
  await app.getByTestId('sidebar-filter').click()
  await sleep(250)
  await shot('filter-menu')
})

await step('search-tooltip', async () => {
  await app.getByTestId('sidebar-search').hover()
  await sleep(900)
  await shot('search-tooltip')
})

await step('rail-tooltip', async () => {
  await app.getByTestId('rail-settings').hover()
  await sleep(900)
  await shot('rail-tooltip')
})

await step('usage-card', async () => {
  const ring = app.getByTestId('rail-usage-claude-code')
  await ring.hover()
  await sleep(600)
  await shot('usage-card')
})

await step('palette', async () => {
  await keys('cmd-k')
  await sleep(300)
  await shot('palette')
  await app.getByTestId('palette-input').fill('sidebar test')
  await sleep(250)
  await app.call('keystrokes', { keys: 'down down' } as never)
  await sleep(150)
  await shot('palette-search')
})

await step('open-thread', async () => {
  await app.getByText('Sidebar test ten reply').click()
  await sleep(1500)
  await shot('thread-open')
  await app.getByTestId('thread-actions').click()
  await sleep(250)
  await shot('thread-actions-menu')
  await keys('escape')
  await app.getByTestId('handoff-menu').click()
  await sleep(250)
  await shot('handoff-menu')
})

await step('history', async () => {
  await app.getByText('Second project test reply').click()
  await sleep(800)
  await app.getByTestId('nav-back').click()
  await sleep(800)
  await shot('history-back')
  await keys('cmd-]')
  await sleep(800)
  await shot('history-forward-key')
})

await step('collapsed', async () => {
  await keys('cmd-b')
  await sleep(300)
  await shot('panel-collapsed')
  await app.getByTestId('titlebar-new-thread').hover()
  await sleep(900)
  await shot('collapsed-new-thread-tooltip')
  await keys('cmd-b')
  await sleep(300)
})

await step('sessions', async () => {
  await app.getByTestId('resume-session').click()
  await sleep(2500)
  await shot('sessions')
})

await step('handoff', async () => {
  await app.getByTestId(`thread-${process.env.HANDOFF_ID ?? '01a13a95-3741-7cf2-8174-ba052f19efe4'}`).click({ button: 2 })
  await sleep(200)
  await app.getByText('Hand off to another agent').click()
  await sleep(400)
  await shot('handoff-dialog')
})

await step('keys', async () => {
  await keys('cmd-n')
  await sleep(400)
  await shot('key-new-chat')
  await keys('cmd-,')
  await sleep(400)
  console.log(`[sidebar] settings page after cmd-, : ${await app.getByTestId('page-settings').count()}`)
  await keys('cmd-[')
  await sleep(400)
  console.log(`[sidebar] settings closed by cmd-[ : ${(await app.getByTestId('page-settings').count()) === 0}`)
})

/** Hover a row and click one of its revealed actions; rows can move as other threads update. */
async function rowAction(rowId: string, actionId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await app.getByTestId(rowId).hover()
    try {
      await app.getByTestId(actionId).waitFor({ timeoutMs: 600 })
      await app.getByTestId(actionId).click()
      return
    } catch {
      await moveAway()
      await sleep(150)
    }
  }
  throw new Error(`${actionId} never appeared`)
}

if (writes) {
  // Thread ids from the scratch daemon: PIN_ID (pinned, renamed, unpinned), ARCHIVE_ID (archived).
  const pinId = process.env.PIN_ID
  const archiveId = process.env.ARCHIVE_ID
  if (pinId)
    await step('pin', async () => {
      await rowAction(`thread-${pinId}`, `pin-${pinId}`)
      await sleep(800)
      await moveAway()
      await sleep(300)
      await shot('pinned')
      await app.getByTestId(`thread-${pinId}`).click({ button: 2 })
      await sleep(200)
      await app.getByText('Rename thread').click()
      await sleep(200)
      await app.getByTestId(`rename-${pinId}`).fill('Renamed by sidebar test')
      await app.getByTestId(`rename-${pinId}`).press('enter')
      await sleep(800)
      await shot('renamed')
      await app.getByTestId(`thread-${pinId}`).hover()
      await sleep(500)
      await app.getByTestId(`pin-${pinId}`).click()
      await sleep(600)
    })
  if (archiveId)
    await step('archive', async () => {
      await rowAction(`thread-${archiveId}`, `archive-${archiveId}`)
      await sleep(800)
      console.log(`[sidebar] archived row still shown: ${await app.getByTestId(`thread-${archiveId}`).count()}`)
      await shot('archived')
    })
}

await app.close()
console.log('[sidebar] done')
