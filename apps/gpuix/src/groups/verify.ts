// Walks every group-project surface in the real window (`verify.fixture.tsx`) and saves screenshots:
//
//   bun src/groups/verify.ts [light|dark|both] [variant…]     # variants: missing, slow, empty, git (one run each)
//   bun src/groups/verify.ts down                             # stop the scratch daemon and delete its folder
//
// A scratch daemon (the installed kybernd, data under …/ade-gpuix-scratch/groups-<slot>) holds two single projects and
// the group folder; the fixture answers the group RPCs the daemon lanes are still building. Output: KYBERN_VERIFY_OUTPUT.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../requests/harness.ts'

const root = process.env.GROUPS_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/groups-lane-b'
if (!root.includes('gpuix-scratch')) throw Error('GROUPS_SCRATCH must contain gpuix-scratch')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(root, 'shots')
const data = path.join(root, 'data')
const daemonBin = process.env.KYBERND ?? '/Applications/kybern.app/Contents/MacOS/kybernd'
const pidFile = path.join(root, 'daemon.pid')

if (process.argv[2] === 'down') {
  try { process.kill(Number(readFileSync(pidFile, 'utf8'))) } catch {}
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd })
function repo(dir: string) {
  mkdirSync(dir, { recursive: true })
  if (existsSync(path.join(dir, '.git'))) return
  writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`)
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '.'); git(dir, '-c', 'user.name=f', '-c', 'user.email=f@x.io', 'commit', '-q', '-m', 'init')
}

async function daemon(): Promise<KybernClient> {
  mkdirSync(data, { recursive: true })
  let port = existsSync(path.join(data, 'daemon.port')) ? readFileSync(path.join(data, 'daemon.port'), 'utf8').trim() : ''
  const alive = existsSync(pidFile) && (() => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return true } catch { return false } })()
  if (!alive) {
    const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const free = s.port!; await s.stop(true)
    rmSync(path.join(data, 'daemon.port'), { force: true })
    const child = spawn(daemonBin, ['--data-dir', data, '--port', String(free)], { stdio: 'ignore', detached: true })
    child.unref()
    writeFileSync(pidFile, String(child.pid))
    for (let i = 0; i < 100 && !existsSync(path.join(data, 'daemon.port')); i++) await Bun.sleep(100)
    port = String(free)
  }
  const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
  client.connect()
  for (let i = 0; i < 100 && client.status !== 'open'; i++) await Bun.sleep(50)
  return client
}

async function seed() {
  const client = await daemon()
  const statePath = path.join(root, 'state.json')
  if (existsSync(statePath)) return
  for (const name of ['api', 'web', 'infra', 'docs', 'services/billing', 'deep/docs']) repo(path.join(root, 'acme', name))
  for (const name of ['anamorphia-gallery', 'acme-api']) repo(path.join(root, name))
  await client.call('projects.add', { path: path.join(root, 'anamorphia-gallery') })
  await client.call('projects.add', { path: path.join(root, 'acme-api') })
  const group = await client.call('projects.add', { path: path.join(root, 'acme'), name: 'acme-platform' })
  writeFileSync(statePath, JSON.stringify({ groupProjectId: group.id, threadId: `01a16bd1-${randomUUID().slice(9)}` }))
}

const modes = process.argv[2] === 'light' || process.argv[2] === 'dark' ? [process.argv[2]] : ['light', 'dark']
const variants = process.argv.slice(3)
await seed()
mkdirSync(out, { recursive: true })
const state = JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8')) as { groupProjectId: string; threadId: string }
const pick = (folder: string) => writeFileSync(path.join(root, 'next-pick.txt'), folder)

for (const mode of modes) {
  pick(path.join(root, 'acme'))
  // Each launch starts from a clean window: drafts and UI state of an earlier run would change what the tray shows.
  rmSync(path.join(root, 'client'), { recursive: true, force: true })
  rmSync(path.join(data, 'gpuix-ui.json'), { force: true })
  const f = await launchFixture(import.meta.dir + '/verify.fixture.tsx', {
    GROUPS_FIXTURE: root, GROUPS_VARIANT: variants.join(','), KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_APPEARANCE: mode,
    GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(root, 'credentials'),
  })
  const app = f.app
  const suffix = `${variants.length ? `-${variants.join('-')}` : ''}-${mode}`
  const shot = async (name: string) => { await app.clock.pause(); await app.clock.fastForward(600); await app.screenshot({ path: path.join(out, `${name}${suffix}.png`) }); await app.clock.resume(); console.log('shot', name) }
  const wait = (id: string, ms = 20000) => app.getByTestId(id).waitFor({ timeoutMs: ms })
  const click = async (id: string, options?: { button?: number }) => {
    const target = app.getByTestId(id)
    await target.waitFor({ timeoutMs: 20000 })
    await app.clock.pause(); await app.clock.fastForward(350); await app.clock.resume()
    await target.click(options)
  }
  try {
    await wait(`project-${state.groupProjectId}`, 60000)
    if (variants.includes('slow') || variants.includes('empty') || variants.includes('git')) {
      // The sheet's other states only.
      await click('add-project'); await click('add-project-group')
      await wait('group-sheet'); await Bun.sleep(300)
      if (variants.includes('git')) { await click('group-candidate-.'); await click('group-candidate-api') }
      await shot('02-sheet')
      continue
    }
    if (variants.includes('missing')) {
      await shot('04-sidebar')
      await click(`project-${state.groupProjectId}`, { button: 2 }); await click('project-menu-repositories')
      await wait('repositories-member-web'); await shot('03-repositories')
      await click('repositories-done'); await Bun.sleep(400)
      await click(`project-new-${state.groupProjectId}`)
      await wait('tray-branch'); await click('tray-branch'); await shot('05-branch-menu')
      continue
    }

    // 1 · the + menu
    await click('add-project'); await wait('add-project-menu'); await shot('01-add-menu')
    // 2 · the group sheet
    await click('add-project-group'); await wait('group-candidate-api'); await shot('02-sheet-opened')
    await click('group-candidate-web'); await shot('02-sheet-one')
    await click('group-candidate-api'); await click('group-candidate-infra'); await shot('02-sheet-valid')
    pick('/Users/mymac/projects/ade-gpuix-scratch/elsewhere')
    await click('group-add-folder'); await Bun.sleep(300); await shot('02-sheet-outside')
    pick(path.join(root, 'acme', 'deep', 'docs'))
    await click('group-add-folder'); await wait('group-candidate-deep/docs'); await shot('02-sheet-added')
    await click('group-cancel'); await Bun.sleep(400)

    // 4 · the sidebar row, its menu and the badge card
    await click(`project-${state.groupProjectId}`, { button: 2 }); await wait('project-menu'); await shot('04-row-menu')
    // 3 · Repositories
    await click('project-menu-repositories'); await wait('repositories-member-api'); await Bun.sleep(300); await shot('03-repositories')
    await app.getByTestId('repositories-member-web').hover(); await click('repositories-menu-web'); await shot('03-row-menu')
    await click('repositories-menu-web'); await Bun.sleep(300)
    await click('repositories-add'); await wait('repositories-checklist'); await click('group-candidate-services/billing'); await shot('03-add')
    await click('repositories-add-cancel'); await wait('repositories-member-api')
    await click('repositories-done'); await Bun.sleep(400)
    await app.getByTestId(`project-badge-${state.groupProjectId}`).hover(); await Bun.sleep(900)
    await shot('04-badge-card')

    // 7 · the instructions offer and 5 · the tray (local mode)
    await click(`project-new-${state.groupProjectId}`)
    await wait('instructions-offer'); await shot('07-offer')
    await click('instructions-preview-toggle'); await Bun.sleep(400); await shot('07-preview')
    await click('instructions-preview-toggle'); await Bun.sleep(400)
    await click('tray-branch'); await wait('tray-branch-repo-web'); await shot('05-branch-local')
    await app.getByTestId('tray-branch-repo-web').hover(); await Bun.sleep(500); await wait('tray-branch-web-main'); await shot('05-branch-submenu')
    await click('tray-branch'); await Bun.sleep(300)
    // worktree mode: the repositories chip
    await click('tray-workspace'); await app.getByText('New worktree').click(); await Bun.sleep(300)
    await wait('tray-repos'); await shot('05-tray-worktree')
    await click('tray-repos'); await wait('tray-repos-infra'); await shot('05-repos-menu')
    await click('tray-repos-infra'); await shot('05-repos-two')
    await click('tray-repos-web'); await shot('05-repos-last')
    await click('tray-repos'); await Bun.sleep(300)
    await click('instructions-create'); await wait('instructions-done'); await Bun.sleep(500); await shot('07-created')

    // 6 · the group thread: transcript card, outside change, environment, dock Changes
    await click(`thread-${state.threadId}`)
    await wait('edited-files'); await wait('outside-change'); await Bun.sleep(400); await shot('06-transcript')
    await click('environment-toggle'); await wait('group-create-prs'); await shot('06-environment')
    await click('group-create-prs'); await wait('group-pr-api', 10000); await Bun.sleep(300); await shot('06-prs')
    await click('environment-toggle'); await Bun.sleep(400)
    // The Changes tab beside the chat: the same grouped rows as the dock's list, with each file's diff.
    await click('edited-review'); await wait('dock-repo-api'); await Bun.sleep(500); await shot('06-changes')
    await click('dock-repo-api'); await Bun.sleep(400); await shot('06-changes-collapsed')
    assert.ok(!f.diagnostics().includes('[error-boundary]'), f.diagnostics())
    console.log(`Group surfaces verified (${mode})`)
  } catch (e) { await shot('failure').catch(() => {}); console.error(f.diagnostics().slice(-3000)); throw e } finally { await f.close() }
}
process.exit(0)
