// On-screen check of Settings → Agent providers (issue #309 and the scroll jump): with the page scrolled mid-way, toggling a
// switch, changing a select and pressing "Check for updates" leave the scroll position exactly where it was, and "Change in
// Settings" on the idle-compaction notice lands on the Compaction section, with and without the optional sections above it.
// The full app runs against a mocked daemon that answers a write a little late, like a real one, and re-reads harness
// updates; the settings document comes from a scratch `kybernd` (`--kybernd`, KYBERND, else `kybernd` on PATH).
//
//   bun scripts/settings-scroll-check.ts [--kybernd <path>]      (PNGs go to KYBERN_VERIFY_OUTPUT, else native/build/settings-scroll)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { PROTOCOL_VERSION } from '../../../packages/kybern-client/src/types.ts'
import { rotationBudgetChoices } from '../../../packages/kybern-client/src/rotation.ts'
import { capture, launch, near, outputDir, pngPixels, sample, scratchDataDir, settled, step, type Fixture } from '../native/check-harness.ts'

const out = outputDir('settings-scroll')
const argv = process.argv.slice(2)
const kybernd = argv.includes('--kybernd') ? argv[argv.indexOf('--kybernd') + 1]! : process.env.KYBERND || 'kybernd'
const WRITE_DELAY_MS = 250

/** The daemon's default settings document, read from a scratch daemon that is stopped again. */
async function defaultSettings() {
  const dir = mkdtempSync(path.join(scratchDataDir(), 'settings-defaults-'))
  const child = spawn(kybernd, ['--data-dir', dir, '--port', '0'], { stdio: 'ignore' })
  try {
    let port = ''
    for (let i = 0; i < 200 && !port; i++) { try { port = readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim() } catch { await Bun.sleep(50) } }
    assert.ok(port, 'the scratch daemon wrote its port')
    const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim() })
    client.connect()
    for (let i = 0; client.status !== 'open' && i < 200; i++) await Bun.sleep(50)
    const settings = await client.call('settings.get', {})
    client.close()
    return settings
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }) }
}

const now = new Date().toISOString()
const provider = (kind: string, display_name: string, version: string) => ({ kind, display_name, available: true, binary_path: `/usr/local/bin/${kind}`, version, unavailable_reason: null, supported_permission_modes: ['supervised', 'auto', 'full'], supports_fork: true, supports_model_switch: true, supports_effort_switch: true, supported_efforts: [], models: [], instances: ['default'] })

interface Mock { stop: () => void; url: string; setOptional: (on: boolean) => void; writes: () => number }
function mockDaemon(initial: Record<string, any>): Mock {
  let settings = initial
  let optional = true
  let writes = 0
  let checking = false
  const thread = { id: 'thread', title: 'Parser refactor', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', created_at: now, updated_at: now }
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('fixture') },
    websocket: {
      async message(ws, raw) {
        const { id, method, params } = JSON.parse(String(raw))
        let result: any = {}
        let error = ''
        switch (method) {
          case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'settings-scroll', version: '1.0.0', hostname: 'Fixture', os: 'linux', arch: 'x86_64', data_dir: '/fixture' }; break
          case 'projects.list': result = { projects: [{ id: 'fixture', name: 'Fixture', path: '/fixture', is_git: true, created_at: now, updated_at: now }] }; break
          case 'threads.list': result = { threads: [], activity: [] }; break
          case 'providers.list': result = {
            providers: [provider('claude-code', 'Claude Code', '2.1.300'), provider('codex', 'Codex', '0.80.0'), provider('opencode', 'OpenCode', '1.2.0'), ...(optional ? [provider('omp', 'Oh My Pi', '13.0.0')] : [])],
            ...(optional ? { coordinator_mcp_servers: { 'claude-code': ['github', 'linear'] } } : {}),
          }; break
          case 'settings.get': result = settings; break
          case 'settings.update':
            writes++
            await Bun.sleep(WRITE_DELAY_MS)
            settings = params.settings; result = settings
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'settings.changed', params: { settings } }))
            break
          case 'harness_updates.list': result = { updates: ['claude-code', 'codex', 'opencode'].map((kind) => ({ kind, status: checking ? 'updating' : 'current', current_version: '1.0.0', latest_version: '1.0.0', checked_at: now, message: '' })) }; break
          case 'harness_updates.run': checking = true; await Bun.sleep(300); checking = false; result = {}; break
          case 'daemon_update.status': result = { status: 'current', current_version: '1.0.0', latest_version: '1.0.0', checked_at: now }; break
          case 'daemon_update.check': await Bun.sleep(300); result = { status: 'current', current_version: '1.0.0', latest_version: '1.0.0', checked_at: now }; break
          case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
          case 'usage.limits': result = { providers: [], accounts: [], refreshing: [] }; break
          case 'cursor.status': result = { sdk_version: 'fixture', installed: false, installing: false, signing_in: false, account: 'signed_out' }; break
          case 'daemon.activity': result = { live_sessions: 0, idle_sessions: 0, terminals: 0, connections: 1 }; break
          case 'providers.accounts.list': result = { accounts: [] }; break
          case 'threads.get': result = { thread, events: [], head_seq: 0 }; break
          default: if (!['ping', 'events.unsubscribe'].includes(method)) error = `Fixture rejects ${method}`
        }
        ws.send(JSON.stringify(error ? { jsonrpc: '2.0', id, error: { code: -32000, message: error } } : { jsonrpc: '2.0', id, result }))
      },
    },
  })
  return { stop: () => server.stop(true), url: `ws://127.0.0.1:${server.port}/ws`, setOptional: (on) => { optional = on }, writes: () => writes }
}

type Sample = { y: number; offset: [number, number] | null }

/** Settings → Agent providers in the full app against the mocked daemon: three clicks mid-page, none of which may move it. */
async function clicks(settings: Record<string, any>, theme: string) {
  const mock = mockDaemon(settings)
  const scratch = mkdtempSync(path.join(scratchDataDir(), 'settings-scroll-'))
  const f: Fixture = await launch(path.join(import.meta.dir, '../src/main.tsx'), {
    KYBERN_URL: mock.url, KYBERN_TOKEN: 'fixture', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1', KYBERN_NO_ACTIVATE: '1',
  })
  const a = f.app
  const offset = async () => (await a.call('getScrollOffset', { elementId: (await a.getByTestId('settings-content').element()).id })).offset as [number, number] | null
  const read = async (id: string): Promise<Sample> => ({ y: (await a.getByTestId(id).bounds()).y, offset: await offset() })
  // Wheel until the control sits near `y` (a positive wheel delta scrolls up).
  const wheelTo = async (id: string, y: number) => {
    await a.getByTestId(id).waitFor({ timeoutMs: 10_000 })
    for (let i = 0; i < 40; i++) {
      const b = await a.getByTestId(id).bounds().catch(() => null)
      if (b && Math.abs(b.y - y) < 40) break
      await a.mouse.wheel({ x: 900, y: 500 }, 0, !b ? -300 : -Math.max(-300, Math.min(300, b.y - y)))
      await Bun.sleep(80)
    }
    await Bun.sleep(300)
  }
  /** Samples the control's position every 40 ms for `ms` after `act`: the page must not move, not even for one sample. */
  const still = async (label: string, id: string, act: () => Promise<void>, ms = 1500) => {
    const before = await read(id)
    await act()
    const seen: Sample[] = []
    for (let t = 0; t < ms; t += 40) { seen.push(await read(id).catch(() => ({ y: Number.NaN, offset: null }))); await Bun.sleep(40) }
    const moved = seen.filter((s) => !(Math.abs(s.y - before.y) <= 0.5))
    console.log(`[settings-scroll] ${theme} ${label}: y ${before.y.toFixed(1)} → ${seen.at(-1)!.y.toFixed(1)}, scroll ${JSON.stringify(before.offset)} → ${JSON.stringify(seen.at(-1)!.offset)}, moved in ${moved.length}/${seen.length} samples`)
    assert.equal(moved.length, 0, `${label}: the page moved (${[...new Set(moved.map((s) => s.y.toFixed(1)))].join(', ')} instead of ${before.y.toFixed(1)})`)
    assert.deepEqual(seen.at(-1)!.offset, before.offset, `${label}: the scroll offset changed`)
  }
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await a.getByTestId('rail-settings').click()
    await a.getByTestId('settings-tab-agents').waitFor({ timeoutMs: 10_000 })
    for (let i = 0; i < 20 && !(await a.getByTestId('settings-max-agents').count()); i++) { await a.getByTestId('settings-tab-agents').click(); await Bun.sleep(250) }
    await a.getByTestId('settings-max-agents').waitFor({ timeoutMs: 10_000 })
    await Bun.sleep(600)

    await step(`${theme}: a switch mid-page keeps the scroll position`, async () => {
      await wheelTo('settings-ask-deadlines', 420)
      const writes = mock.writes()
      await still('switch', 'settings-ask-deadlines', () => a.getByTestId('settings-ask-deadlines').click())
      assert.equal(mock.writes(), writes + 1, 'the switch saved')
    })
    await step(`${theme}: a select mid-page keeps the scroll position`, async () => {
      await wheelTo('settings-rotation-budget', 380)
      const choice = rotationBudgetChoices(null).find((c) => c.value !== String(settings.orchestration?.rotation_budget_tokens ?? 200_000))!.value
      await still('select', 'settings-rotation-budget', async () => {
        await a.getByTestId('settings-rotation-budget').click()
        await a.getByTestId(`settings-rotation-budget-${choice}`).waitFor({ timeoutMs: 3000 })
        await a.getByTestId(`settings-rotation-budget-${choice}`).click()
      })
      await capture(f, path.join(out, `select-${theme}.png`))
    })
    await step(`${theme}: two quick switches both save, and the page stays put`, async () => {
      await wheelTo('settings-ask-deadlines', 420)
      const writes = mock.writes()
      await still('two switches', 'settings-ask-deadlines', async () => {
        await a.getByTestId('settings-ask-deadlines').click()
        await a.getByTestId('settings-ask-deadlines').click()
      })
      assert.equal(mock.writes(), writes + 2, 'the second click was not dropped while the first saved')
    })
    await step(`${theme}: "Check for updates" keeps the scroll position`, async () => {
      await wheelTo('agent-check-codex', 420)
      await still('check for updates (agent)', 'agent-check-codex', () => a.getByTestId('agent-check-codex').click(), 2500)
      await wheelTo('settings-daemon-check', 420)
      await still('check for updates (daemon)', 'settings-daemon-check', () => a.getByTestId('settings-daemon-check').click(), 1500)
    })
  } catch (error) {
    await capture(f, path.join(out, `clicks-failure-${theme}.png`)).catch(() => {})
    throw error
  } finally { await f.close(); mock.stop(); rmSync(scratch, { recursive: true, force: true }) }
}

/** "Change in Settings" on the idle-compaction notice opens Agent providers with Compaction at the top, tinted once. */
async function landing(settings: Record<string, any>, theme: string, optional: boolean, reduced: boolean) {
  const label = `${theme}, ${optional ? 'with' : 'without'} the optional rows${reduced ? ', Reduce Motion' : ''}`
  const scratch = mkdtempSync(path.join(scratchDataDir(), 'settings-landing-'))
  const f: Fixture = await launch(path.join(import.meta.dir, '../src/settings/landing.fixture.tsx'), {
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '',
    KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: reduced ? '1' : '0', LANDING_OPTIONAL: optional ? '1' : '0', LANDING_SETTINGS: JSON.stringify(settings),
  })
  const a = f.app
  const name = `landing-${theme}${optional ? '-optional' : ''}${reduced ? '-reduced' : ''}`
  try {
    await a.getByTestId('landing-ready').waitFor({ timeoutMs: 60_000 })
    await a.getByTestId('idle-compaction-toggle-turn2').click()
    await a.getByTestId('idle-compaction-settings').waitFor({ timeoutMs: 5000 })
    await Bun.sleep(400)
    await a.getByTestId('idle-compaction-settings').click()
    // The tint is up for 0.7 s after landing (0.2 s fade-in), then fades for 0.4 s; Reduce Motion skips it. Wait on its state,
    // which the first row's overlay reports as a test id while it is lit, and capture the card while it is up: a capture can
    // take longer than the tint on a software renderer, so only a frame taken with the tint up before and after counts.
    const tint = async () => (await a.getByTestId('settings-section-compaction-tint').count()) > 0
    const lit: string[] = []
    let seen = false
    const start = Date.now()
    for (let deadline = start + 8000; Date.now() < deadline;) {
      if (await tint()) {
        seen = true
        const file = await capture(f, path.join(out, `${name}-lit-${lit.length}.png`))
        if (await tint()) lit.push(file)
      } else if (seen || (reduced && Date.now() - start > 2500)) break
      await Bun.sleep(20)
    }
    await step(`${label}: Compaction is at the top of Agent providers`, async () => {
      await a.getByTestId('settings-section-compaction').waitFor({ timeoutMs: 10_000 })
      const page = await a.getByTestId('page-settings').bounds()
      const header = await settled(() => a.getByTestId('settings-section-compaction').bounds().catch(() => null), (b) => !!b && Math.abs(b.y - page.y) <= 1, 3000)
      assert.ok(header && Math.abs(header.y - page.y) <= 1, `the Compaction header is at the top (${header?.y} vs ${page.y})`)
      const text = (await a.call('getPaintedText', {})).text.join('\n')
      assert.ok(text.includes('Compact idle threads'), 'the Compaction rows are painted')
      assert.equal(await a.getByTestId('settings-tab-agents').count(), 1)
    })
    await step(`${label}: the section is tinted once${reduced ? ' (not under Reduce Motion)' : ''}`, async () => {
      assert.equal(seen, !reduced, reduced ? 'no tint under Reduce Motion' : 'the card is tinted after landing')
      assert.equal(await settled(tint, (up) => !up, 5000), false, 'the tint goes away')
      const header = await a.getByTestId('settings-section-compaction').bounds()
      // The card is the page block's centred column (680 wide at most, 40 of padding each side); sample its first row.
      const inner = Math.min(680, header.width - 80)
      const card = { x: header.x + (header.width - inner) / 2 + 20, y: header.y + 40, width: inner - 40, height: 40 }
      const pixels = (file: string) => { const p = pngPixels(file); return sample(p, Math.round((p.width / 1200) * 2) / 2, card, 8) }
      const same = (x: number[][], y: number[][]) => x.every((px, i) => near(px, y[i]!))
      // At rest once the fade-out is over: two captures in a row paint the card the same.
      let previous = pixels(await capture(f, path.join(out, `${name}-settled.png`)))
      const rest = await settled(async () => { const next = pixels(await capture(f, path.join(out, `${name}-settled.png`))); const done = same(previous, next); previous = next; return { next, done } }, (r) => r.done, 5000)
      assert.ok(rest.done, 'the card settles after the tint')
      if (reduced) return
      if (lit.length === 0) { console.log(`[settings-scroll] ${label}: no capture finished while the tint was up; its state was checked through automation`); return }
      assert.ok(lit.some((file) => !same(pixels(file), rest.next)), 'a frame taken while the tint was up paints the card differently from rest')
    })
  } catch (error) {
    await capture(f, path.join(out, `${name}-failure.png`)).catch(() => {})
    throw error
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}

const settings = await defaultSettings()
const themes = process.env.KYBERN_APPEARANCE ? [process.env.KYBERN_APPEARANCE] : ['dark', 'light']
for (const theme of themes) {
  await clicks(settings, theme)
  await landing(settings, theme, false, false)
  await landing(settings, theme, true, false)
}
await landing(settings, themes[0]!, true, true)
console.log(`settings scroll checks done; screenshots in ${out}`)
process.exit(0)
