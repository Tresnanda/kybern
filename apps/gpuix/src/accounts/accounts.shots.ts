// Drives "Accounts across machines" on the fixture's machines and captures each surface:
// `bun src/accounts/accounts.shots.ts` (PNGs go to KYBERN_VERIFY_OUTPUT, else native/build/accounts). Needs the patched
// addon and a screen; every launch uses a scratch directory.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { acquirePreviewUiLock } from '../../scripts/preview-ui-lock.ts'

const out = path.resolve(process.env.KYBERN_VERIFY_OUTPUT ?? 'native/build/accounts')
mkdirSync(out, { recursive: true })
const release = acquirePreviewUiLock()
const themes = (process.env.ACCOUNTS_THEMES ?? 'dark,light').split(',').filter(Boolean)

async function run(theme: string, env: Record<string, string>, steps: (a: Awaited<ReturnType<typeof launchFixture>>['app'], shot: (name: string) => Promise<void>) => Promise<void>) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-accounts-'))
  const f = await launchFixture(path.join(import.meta.dir, 'accounts.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch,
    KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_WINDOW_SIZE: '1280x880', ...env,
  })
  const shot = async (name: string) => { await Bun.sleep(500); await f.app.screenshot({ path: path.join(out, `${name}-${theme}.png`) }); console.log(`shot ${name}-${theme}`) }
  try {
    await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await steps(f.app, shot)
  } catch (error) {
    await f.app.screenshot({ path: path.join(out, `failed-${theme}.png`) }).catch(() => {})
    console.error(f.diagnostics())
    throw error
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}

try {
  for (const theme of themes) {
    await run(theme, {}, async (a, shot) => {
      const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 20_000 }); await a.getByTestId(id).click() }
      // On opening: the new-machine card, then the thread at its limit under it.
      await a.getByTestId('offer-card-new_machine').waitFor({ timeoutMs: 30_000 })
      await a.getByTestId('usage-limit-recovery').waitFor({ timeoutMs: 20_000 })
      await a.getByTestId('account-wait-cancel').waitFor()
      await a.getByTestId('account-undo').waitFor()
      await shot('offer-card')
      await click('offer-later')
      const gone = Date.now() + 5000
      while (await a.getByTestId('offer-card-new_machine').count()) { assert.ok(Date.now() < gone, '“Not now” closes the card'); await Bun.sleep(100) }
      assert.match(await a.getByTestId('usage-switch-continue').textContent(), /Continue on Personal/)
      await shot('limit-card')
      await a.getByTestId('rail-usage-claude-code').hover()
      await a.getByTestId('rail-accounts-claude-code').waitFor({ timeoutMs: 10_000 })
      assert.match(await a.getByTestId('rail-accounts-claude-code').textContent(), /49% left/)
      assert.equal(await a.getByTestId(`rail-account-add-claude-code:sam@hey.example`).count(), 0, 'the rail card has no + per account')
      await shot('rail-hover-card')
      await a.getByTestId('app-ready').hover()
      await click('rail-settings')
      await click('settings-tab-accounts')
      const PERSONAL = 'claude-code:sam@hey.example'
      const WORK = 'claude-code:sam@acme.example'
      const text = (id: string) => a.getByTestId(id).textContent()
      // Scroll the settings page until a control below the fold is on screen.
      const reveal = async (id: string) => {
        await a.getByTestId(id).waitFor({ timeoutMs: 20_000 })
        for (let i = 0; i < 8; i++) {
          const box = await a.getByTestId(id).bounds()
          if (box.y > 60 && box.y + box.height < 860) return
          await a.mouse.wheel({ x: 900, y: 500 }, 0, box.y > 60 ? -300 : 300)
          await Bun.sleep(250)
        }
      }
      // Personal: signed in here, signed out on fedora, not signed in on kdi-vps, studio offline, pi-box too old.
      await click(`account-row-${PERSONAL}`)
      await a.getByTestId(`machine-status-${PERSONAL}-old`).waitFor({ timeoutMs: 20_000 })
      assert.match(await text(`account-summary-${PERSONAL}`), /Signed out on fedora/)
      assert.match(await text(`machine-status-${PERSONAL}-mac`), /Signed in/)
      assert.match(await text(`machine-status-${PERSONAL}-fedora`), /Signed out/)
      assert.match(await text(`machine-status-${PERSONAL}-vps`), /Not signed in/)
      assert.match(await text(`machine-status-${PERSONAL}-studio`), /Offline/)
      assert.match(await text(`machine-status-${PERSONAL}-old`), /Needs a newer Kybern/)
      await a.getByTestId(`machine-signin-${PERSONAL}-fedora`).waitFor()
      await a.getByTestId(`machine-update-${PERSONAL}-old`).waitFor()
      assert.doesNotMatch(await text('accounts-card'), /Terminal login/)
      await shot('accounts-page')
      // Work: the default, at its limit, borrowed on SatyaMas.
      await click(`account-row-${WORK}`)
      await a.getByTestId(`machine-status-${WORK}-satya`).waitFor({ timeoutMs: 10_000 })
      assert.match(await text(`machine-status-${WORK}-satya`), /From fedora/)
      assert.match(await text(`account-usage-${WORK}`), /0% left/)
      await shot('account-work')
      await click(`machine-more-${WORK}-fedora`)
      await a.getByTestId(`machine-remove-${WORK}-fedora`).waitFor()
      await shot('machine-menu')
      await a.getByTestId(`machine-remove-${WORK}-fedora`).press('escape')
      await Bun.sleep(300)
      await reveal(`account-remove-${WORK}`)
      await click(`account-remove-${WORK}`)
      await a.getByTestId('account-remove-confirm').waitFor()
      await shot('remove-account')
      await click('account-remove-cancel')
      // Personal is this computer's own login: signing it out says the terminal signs out too.
      await reveal(`account-row-${PERSONAL}`)
      await click(`account-row-${PERSONAL}`)
      await click(`machine-more-${PERSONAL}-mac`)
      await click(`machine-signout-${PERSONAL}-mac`)
      await a.getByTestId('account-terminal-signout-confirm').waitFor()
      await shot('terminal-signout')
      await click('account-terminal-signout-cancel')
      // Shared sign-ins: fedora lends Claude Code, kdi-vps Codex.
      await a.getByTestId('accounts-sharing').waitFor({ timeoutMs: 20_000 })
      await reveal('sharing-row-codex')
      assert.equal(await a.getByTestId('sharing-row-omp').count(), 0, 'omp is listed only where someone has it')
      await Bun.sleep(500)
      assert.match(await text('sharing-row-claude-code'), /From fedora/)
      assert.match(await text('sharing-row-codex'), /From kdi-vps/)
      assert.match(await text('sharing-note-codex'), /often offline/)
      await shot('shared-sign-ins')
      await click('sharing-codex')
      await Bun.sleep(400)
      await shot('sharing-menu')
      await a.getByTestId('sharing-codex').press('escape')
      await Bun.sleep(300)
      // Back to the top, where the heading's Add account is: opening the tab again starts there.
      await click('settings-tab-general')
      await click('settings-tab-accounts')
      await click('account-add')
      await click('account-provider-claude-code')
      await a.getByTestId('account-machines').waitFor()
      await shot('add-account')
      await click('account-start')
      // This computer signs in through the browser; the other machines ask for one Authorize each.
      await a.getByTestId('account-code-instead').waitFor({ timeoutMs: 20_000 })
      await click('account-skip')
      await a.getByTestId('account-authorize').waitFor({ timeoutMs: 20_000 })
      await shot('add-account-authorize')
      await click('account-cancel')
    })
  }
  await run('dark', { ACCOUNTS_DEMO_OFFER: 'clash' }, async (a, shot) => {
    await a.getByTestId('offer-card-migration_clash').waitFor({ timeoutMs: 30_000 })
    await shot('offer-clash')
  })
  await run('dark', { ACCOUNTS_DEMO_AWAY: '1' }, async (a, shot) => {
    await a.getByTestId('account-away-use').waitFor({ timeoutMs: 30_000 })
    assert.match(await a.getByTestId('account-away-use').textContent(), /Use Personal here/)
    await shot('account-away')
  })
  await run('dark', { ACCOUNTS_DEMO_DELEGATED: '1' }, async (a, shot) => {
    // The agents' rows name an account only off the default, on this machine and on another.
    const line = async (call: number) => {
      const id = `launch-member-tool:call-${call}`
      await a.getByTestId(id).waitFor({ timeoutMs: 30_000 })
      // The row remounts when its child's thread arrives.
      return a.getByTestId(id).textContent().catch(() => '')
    }
    const until = async (call: number, wanted: RegExp) => {
      const deadline = Date.now() + 15_000
      while (!wanted.test(await line(call))) { assert.ok(Date.now() < deadline, `row ${call} reads ${wanted}: ${await line(call)}`); await Bun.sleep(100) }
    }
    // The group folds once every agent is done: open it.
    await a.getByTestId('launch-group-tool:call-0').waitFor({ timeoutMs: 30_000 })
    await Bun.sleep(1500)
    if (!await a.getByTestId('launch-member-tool:call-0').count()) await a.getByTestId('launch-group-tool:call-0').click()
    await until(1, /Claude Opus 5\.5 · Personal · Own worktree/)
    await until(2, /Claude Opus 5\.5 · Personal · on fedora · Own worktree/)
    assert.doesNotMatch(await line(0), /Work ·|Personal/)
    if (await a.getByTestId('offer-later').count()) await a.getByTestId('offer-later').click()
    await Bun.sleep(600)
    await shot('delegated-agents')
  })
  console.log(`PASS accounts: captures in ${out}`)
} finally { release() }
