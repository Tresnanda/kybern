// Native verification of the compaction UI (`compaction.fixture.tsx`, issue #295): the Compaction settings section and an
// account's "Compact idle threads" menu, the idle-compaction notice running and settled with its card, and the composer's
// prompt-cache caption from the recorded TTL. Light and dark. Screenshots go to $KYBERN_VERIFY_OUTPUT.
//
//   bun src/settings/compaction.verify.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(tmpdir(), 'kybern-compaction-verify')
mkdirSync(out, { recursive: true })

type Fixture = Awaited<ReturnType<typeof launchFixture>>
const painted = async (f: Fixture) => (await f.app.call('getPaintedText', {})).text as string[]
const settle = async (f: Fixture, ms = 700) => { for (let t = 0; t < ms; t += 50) { await Bun.sleep(10); await f.app.clock.fastForward(50) } }
const has = async (f: Fixture, text: string) => (await painted(f)).some((line) => line.includes(text))
async function until(f: Fixture, text: string, present = true, ms = 6000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if ((await has(f, text)) === present) return; await settle(f, 100) }
  throw new Error(`Timed out waiting for ${present ? '' : 'absence of '}painted text: ${text}\n${(await painted(f)).join('\n')}`)
}

async function launch(mode: string, theme: string) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-compaction-'))
  const f = await launchFixture(import.meta.dir + '/compaction.fixture.tsx', {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '0', COMPACTION_MODE: mode,
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '',
  })
  return { f, scratch }
}

async function settings(theme: string) {
  const { f, scratch } = await launch('settings', theme)
  try {
    await f.app.getByTestId('compaction-ready').waitFor({ timeoutMs: 30000 })
    await settle(f, 500)
    for (const text of ['Compaction', 'Compact idle threads', 'Before the cache expires', 'Threads over 200K tokens are compacted about 2 minutes before their prompt cache expires, while the history is still cached.', '1 account uses its own setting.', 'Auto-compact at', 'Claude Code', '400K', 'Codex', 'OpenCode', 'Oh My Pi']) {
      assert.ok(await has(f, text), `painted: ${text}`)
    }
    assert.ok(!(await has(f, 'Cursor')), 'an agent without its own limit has no row')
    await f.app.screenshot({ path: `${out}/compaction-settings-${theme}.png` })
    await f.app.getByTestId('account-menu-open').click()
    await f.app.getByTestId('account-idle').waitFor()
    await f.app.getByTestId('account-idle').hover()
    await until(f, 'Use default (Before the cache expires)')
    await settle(f, 400)
    await f.app.screenshot({ path: `${out}/compaction-account-menu-${theme}.png` })
  } finally {
    await f.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function transcript(theme: string) {
  const { f, scratch } = await launch('transcript', theme)
  try {
    await f.app.getByTestId('compaction-ready').waitFor({ timeoutMs: 30000 })
    await until(f, 'Compacted while you were away ·')
    assert.ok(!(await has(f, '/compact')), 'the idle compaction shows no /compact message')
    await f.app.getByTestId('idle-compaction-toggle-turn2').click()
    await f.app.getByTestId('idle-compaction-card-turn2').waitFor()
    await settle(f, 500)
    for (const text of ['Compacted', '312K → 38K tokens · 2 minutes before the 1-hour cache expired', 'Your next message starts from a summary instead of re-reading the whole thread.', 'Change in Settings']) {
      assert.ok(await has(f, text), `painted: ${text}`)
    }
    await f.app.screenshot({ path: `${out}/compaction-notice-${theme}.png` })
    await f.app.getByTestId('composer-status').click()
    await f.app.getByTestId('composer-status-popover').waitFor()
    await settle(f, 500)
    await until(f, 'This thread’s 1-hour cache has about 52 minutes left. Kybern compacts it at')
    assert.ok(!(await has(f, 'documented')) && !(await has(f, 'Actual retention')), 'no estimate wording')
    await f.app.screenshot({ path: `${out}/compaction-popover-${theme}.png` })
    await f.app.getByTestId('composer-status').click()
    await settle(f, 300)
    await f.app.getByTestId('compaction-running').click()
    await until(f, 'Compacting…')
    await settle(f, 400)
    await f.app.screenshot({ path: `${out}/compaction-running-${theme}.png` })
  } finally {
    await f.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

for (const theme of ['light', 'dark']) {
  await settings(theme)
  await transcript(theme)
}
console.log(`compaction UI verified; screenshots in ${out}`)
process.exit(0)
