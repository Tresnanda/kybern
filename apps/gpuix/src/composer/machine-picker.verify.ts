// The composer's machine chip (design §6.1) against two real scratch daemons, in the real app. One machine: no chip and nothing
// changed. Two machines that share a repository: the chip appears, defaults to the machine you are at, the pick creates the
// thread on the other machine, and a send to a machine that is away waits in the outbox ("Waiting for satyamas") and is still
// there after the app restarts. Delivery itself is the daemons' peer link (a tailnet), which two scratch daemons on one Mac
// cannot form; the outbox → chat mapping is covered by `packages/kybern-client/tests/new-chat.test.mjs`.
//
// KYBERND=<kybernd binary> R3_SCRATCH=<scratch dir> KYBERN_VERIFY_OUTPUT=<screenshot dir> bun src/composer/machine-picker.verify.ts
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../requests/harness.ts'

const R3 = process.env.R3_SCRATCH ?? '/private/tmp/claude-501/-Users-mymac-projects-ade/7114be41-5712-41f3-840b-16d8da982749/scratchpad/r3'
const OUT = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-91/r3'
const KYBERND = process.env.KYBERND ?? path.resolve(import.meta.dir, '../../../../target/debug/kybernd')
const KYBERN = path.join(path.dirname(KYBERND), 'kybern')
const ENTRY = path.resolve(import.meta.dir, '../main.tsx')
const PORT = { a: 4301, b: 4302 }
mkdirSync(OUT, { recursive: true })

const until = async (check: () => Promise<boolean> | boolean, label: string, ms = 20000) => {
  const end = Date.now() + ms
  for (;;) { try { if (await check()) return } catch { /* not yet */ } if (Date.now() > end) throw Error(`Timed out: ${label}`); await Bun.sleep(60) }
}

function startDaemon(name: 'a' | 'b'): ChildProcess {
  const dir = path.join(R3, name)
  mkdirSync(dir, { recursive: true }); mkdirSync(path.join(R3, `home-${name}`), { recursive: true })
  // A scratch HOME: no agent CLI of the user's is signed in here, so a send can never start a real turn.
  return spawn(KYBERND, ['--data-dir', dir, '--port', String(PORT[name])], { env: { HOME: path.join(R3, `home-${name}`), PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', openSync(path.join(R3, `${name}.log`), 'a')] })
}
async function daemonClient(name: 'a' | 'b'): Promise<KybernClient> {
  const dir = path.join(R3, name)
  await until(() => existsSync(path.join(dir, 'daemon.token')), `daemon ${name} token`, 30000)
  const client = new KybernClient({ url: `ws://127.0.0.1:${PORT[name]}/ws`, token: readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim() })
  client.connect()
  await until(() => client.status === 'open', `daemon ${name} connection`, 30000)
  return client
}
const stop = async (child: ChildProcess) => { child.kill(); await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()) }) }

let lastApp: Awaited<ReturnType<typeof launchFixture>> | undefined
// An idle window paints nothing new: a short clock step and a capture flush the pending frame before the read.
const painted = async (app: Awaited<ReturnType<typeof launchFixture>>['app']) => { await app.clock.fastForward(16); await app.screenshot({ path: `${R3}/.flush.png` }); return String((await app.call('getPaintedText', {})).text) }

async function run(theme: 'dark' | 'light') {
  rmSync(R3, { recursive: true, force: true }); mkdirSync(R3, { recursive: true })
  // The same repository on both machines: one root commit, two checkouts.
  const repoA = path.join(R3, 'repo-a'), repoB = path.join(R3, 'repo-b')
  execFileSync('git', ['init', '-q', repoA])
  writeFileSync(path.join(repoA, 'README.md'), '# Machine picker fixture\n')
  execFileSync('git', ['-C', repoA, 'add', 'README.md'])
  execFileSync('git', ['-C', repoA, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'Fixture'])
  execFileSync('git', ['clone', '-q', repoA, repoB])

  let daemonA = startDaemon('a'), daemonB = startDaemon('b')
  const clientA = await daemonClient('a'), clientB = await daemonClient('b')
  const closers: (() => Promise<void> | void)[] = []
  try {
    const projectA = await clientA.call('projects.add', { path: repoA, name: 'Picker fixture' })
    const projectB = await clientB.call('projects.add', { path: repoB, name: 'Picker fixture' })
    // Daemon gap: nothing in kybernd fills `projects.repo_identity` yet (only the store has the setter), so projects never merge across
    // machines. The scratch daemons get what the daemon will write, so the client side can be checked.
    const root = execFileSync('git', ['-C', repoA, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim()
    for (const name of ['a', 'b'] as const) execFileSync('sqlite3', [path.join(R3, name, 'state.sqlite'), `UPDATE projects SET repo_identity = '{"repo":{"root_commit":"${root}"}}';`])
    for (const [label, c] of [['A', clientA], ['B', clientB]] as const) console.log('repo identity', label, JSON.stringify((await c.call('projects.list', {})).projects.map((p) => [p.name, p.repo])))
    const idB = clientB.info?.environment_id
    assert.ok(idB, 'daemon B reports its environment id')
    // B is in A's network, so A's outbox accepts work for it (the peer link itself needs a tailnet).
    const code = /Code: (\d{6})/.exec(execFileSync(KYBERN, ['--data-dir', path.join(R3, 'b'), 'machines', 'code'], { encoding: 'utf8' }))?.[1]
    execFileSync(KYBERN, ['--data-dir', path.join(R3, 'a'), 'machines', 'join', code!, `ws://127.0.0.1:${PORT.b}/ws`], { encoding: 'utf8' })

    for (const [label, c] of [['A', clientA], ['B', clientB]] as const) console.log('agents', label, JSON.stringify((await c.call('providers.list', {})).providers.map((p) => [p.kind, p.available])))
    // Both scratch daemons are this Mac, so both would be named after its hostname: name them the way the person would.
    const idA = clientA.info?.environment_id
    for (const [id, name] of [[idA, 'Mac'], [idB, 'satyamas']] as const) execFileSync(KYBERN, ['--data-dir', path.join(R3, 'a'), 'machines', 'rename', id!, name], { encoding: 'utf8' })
    await Bun.sleep(1500)

    const client = path.join(R3, 'client'), creds = path.join(R3, 'credentials')
    mkdirSync(client, { recursive: true }); mkdirSync(creds, { recursive: true })
    const launch = (extra: Record<string, string> = {}) => launchFixture(ENTRY, {
      GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '1', KYBERN_NO_ACTIVATE: '1',
      KYBERN_DATA_DIR: path.join(R3, 'a'), KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: creds, KYBERN_ENVIRONMENT_NAME: 'Mac',
      KYBERN_URL: '', KYBERN_TOKEN: '', ...extra,
    })
    const open = async (name: string) => {
      const f = await launch()
      closers.push(() => f.close())
      lastApp = f
      await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
      return f
    }

    // ---- one machine: no chip, the composer as it was ----
    {
      const f = await open('single')
      await until(async () => (await f.app.getByTestId('composer').count()) > 0, 'home paints')
      await Bun.sleep(800)
      assert.equal(await f.app.getByTestId('machine-picker').count(), 0, 'one machine shows no machine chip')
      await f.app.screenshot({ path: `${OUT}/single-${theme}.png` })
      await f.close(); closers.pop()
    }

    // ---- two machines ----
    // The single-machine launch made `machines.json`; the saved machine is read from `environments.json` only the first time.
    for (const file of ['machines.json', 'machine-cache.json']) rmSync(path.join(client, file), { force: true })
    writeFileSync(path.join(client, 'environments.json'), JSON.stringify({ selected_id: 'local', environments: [{ id: 'sat', name: 'satyamas', url: `ws://127.0.0.1:${PORT.b}/ws`, local: false }] }))
    writeFileSync(path.join(creds, `${encodeURIComponent('sat')}.token`), readFileSync(path.join(R3, 'b', 'daemon.token'), 'utf8').trim(), { mode: 0o600 })
    let f = await open('two')
    let app = f.app
    await until(async () => (await app.getByTestId('machine-picker').count()) > 0, 'machine chip appears with two machines', 40000)
    await Bun.sleep(600)
    assert.ok((await painted(app)).includes('Mac'), 'the default machine is the one you are at')
    await app.screenshot({ path: `${OUT}/chip-${theme}.png` })
    await app.getByTestId('machine-picker').click()
    await until(async () => (await app.getByTestId(`machine-${idB}`).count()) > 0, 'machine rows')
    await Bun.sleep(300)
    const menu = await painted(app)
    assert.ok(menu.includes('satyamas') && menu.includes('Online'), 'the other machine is listed with its state')
    await app.screenshot({ path: `${OUT}/menu-${theme}.png` })
    await app.getByTestId(`machine-${idB}`).click()
    await until(async () => (await app.getByTestId(`machine-${idB}`).count()) === 0, 'menu closes')
    // The agent list follows the chosen machine.
    await until(async () => (await app.getByTestId('model-picker').count()) > 0, "satyamas' agents appear", 40000)
    await app.getByTestId('model-picker').click()
    await Bun.sleep(500)
    await app.screenshot({ path: `${OUT}/agents-on-satyamas-${theme}.png` })
    await app.getByTestId('model-picker').press('escape').catch(() => {})
    await until(async () => (await app.getByTestId('model-search').count()) === 0, 'agent picker closes').catch(() => {})

    const first = `Hello from the picker ${theme}`
    await app.getByTestId('composer').fill(first)
    await app.getByTestId('composer').press('enter')
    await until(async () => (await clientB.call('threads.list', {})).threads.some((t) => t.title === first), 'the chat is made on satyamas', 40000)
    assert.ok(!(await clientA.call('threads.list', {})).threads.some((t) => t.title === first), 'and not on the machine you are at')
    await Bun.sleep(1200)
    await app.screenshot({ path: `${OUT}/created-on-satyamas-${theme}.png` })
    console.log(`PASS ${theme}: chip, default, pick, create on the other machine`)

    // ---- the other machine goes away: the send waits ----
    await app.getByTestId(`project-${projectA.id}`).click()
    await until(async () => (await app.getByTestId('composer').count()) > 0 && (await app.getByTestId('machine-picker').count()) > 0, 'new chat composer')
    await Bun.sleep(500)
    // The last machine used is remembered for the project.
    await stop(daemonB)
    await app.getByTestId('machine-picker').click()
    await until(async () => (await painted(app)).includes('sends when it returns'), 'the away machine says so', 60000)
    await app.screenshot({ path: `${OUT}/menu-offline-${theme}.png` })
    await app.getByTestId('machine-picker').press('escape').catch(() => {})
    await Bun.sleep(300)
    const queued = `Queued while away ${theme}`
    await app.getByTestId('composer').fill(queued)
    await app.getByTestId('composer').press('enter')
    await until(async () => (await painted(app)).includes('Waiting for satyamas'), 'the chat waits for satyamas', 20000)
    await Bun.sleep(800)
    await app.screenshot({ path: `${OUT}/waiting-${theme}.png` })
    const items = (await clientA.call('outbox.list', {})).items.filter((item) => item.kind === 'thread_create')
    assert.equal(items.length, 1, 'one create waits in the outbox of the machine you are at')
    assert.equal(items[0]!.target, idB)
    assert.equal((items[0]!.payload as { message?: { parts: { text?: string }[] } }).message?.parts[0]?.text, queued)
    console.log(`PASS ${theme}: send to an away machine waits in the outbox`)

    // ---- the app restarts: the waiting chat is still there ----
    await f.close(); closers.pop()
    daemonB = startDaemon('b')
    f = await open('restart'); app = f.app
    await until(async () => (await painted(app)).includes(queued), 'the waiting chat is listed after a restart', 40000)
    await app.getByTestId(`thread-${(items[0]!.payload as { thread_id: string }).thread_id}`).click()
    await until(async () => (await painted(app)).includes('Waiting for satyamas'), 'and still waits', 20000)
    await Bun.sleep(1500)
    const after = await painted(app)
    assert.ok(after.includes('Waiting for satyamas') && after.split(queued).length > 2, 'the first message and the wait are both still shown')
    await app.screenshot({ path: `${OUT}/waiting-after-restart-${theme}.png` })
    console.log(`PASS ${theme}: the waiting chat survives a restart`)
    void projectB
  } catch (error) {
    console.log(`FAIL ${theme}:`, error)
    if (lastApp) { await lastApp.app.screenshot({ path: `${OUT}/failed-${theme}.png` }).catch(() => {}); console.log((await painted(lastApp.app).catch(() => '')).slice(-1200)); console.log(lastApp.diagnostics().slice(-1500)) }
    throw error
  } finally {
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => {})
    clientA.close?.(); clientB.close?.()
    await stop(daemonA).catch(() => {}); await stop(daemonB).catch(() => {})
  }
}

for (const theme of (process.env.THEMES ?? 'dark,light').split(',') as ('dark' | 'light')[]) await run(theme)
process.exit(0)
