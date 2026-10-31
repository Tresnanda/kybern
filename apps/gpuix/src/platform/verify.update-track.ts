// Update tracks in a real window, against two local signed feeds (stable at
// this version, dev with a newer dev build) and a scratch bundle: a Stable
// install is offered nothing, switching Settings › About to Dev offers and
// installs the dev build, switching back offers nothing again, and the
// installed dev build on Stable stays put (no downgrade) and says so.
//
//   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/platform/verify.update-track.ts <out-dir> [dark|light]
//
// The scratch daemon must start on the Stable track (a fresh data folder).
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { assertScratchDataDir, until } from './verify.lib.ts'

assertScratchDataDir()
import { archive, fakeBundle, serveFeed, testKey } from './verify.feed.ts'

const out = process.argv[2] ?? '/tmp/update-track-check'
const theme = process.argv[3] ?? 'dark'
mkdirSync(out, { recursive: true })
const root = mkdtempSync(path.join(tmpdir(), 'kybern-update-track-'))
const key = testKey()
const installed = fakeBundle(path.join(root, 'Applications'), '0.9.1')
const devArchive = archive(fakeBundle(path.join(root, 'next'), '0.9.2-dev.1', 1024 * 1024), path.join(root, 'next.tar.gz'))
// latest.json still names the installed version; latest-dev.json names the dev build.
const stable = await serveFeed({ version: '0.9.1', archive: devArchive, signature: key.signFile(devArchive, 'gpuix.app.tar.gz'), ms: 300 })
const dev = await serveFeed({ version: '0.9.2-dev.1', archive: devArchive, signature: key.signFile(devArchive, 'gpuix.app.tar.gz'), ms: 1200, notes: '- Try the new things first.' })
const version = () => readFileSync(path.join(installed, 'Contents/Resources/version'), 'utf8')

async function open(appVersion: string) {
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'client'), KYBERN_GPUIX_VERSION: appVersion,
    KYBERN_UPDATE_FEED: stable.url, KYBERN_UPDATE_DEV_FEED: dev.url, KYBERN_UPDATE_PUBKEY: key.pubkey, KYBERN_UPDATE_BUNDLE: installed,
    KYBERN_UPDATE_FIRST_CHECK_MS: '300', KYBERN_UPDATE_NO_RELAUNCH: '1',
  } })
  const click = async (id: string) => { await app.getByTestId(id).click() }
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  // Let the first check (300 ms after launch) finish.
  await Bun.sleep(2500)
  const about = async () => {
    // A background window may take the first click as a hover; click until Settings opens.
    await until(async () => {
      if (await app.getByTestId('page-settings').count()) return true
      await click('rail-settings')
      await Bun.sleep(800)
      return (await app.getByTestId('page-settings').count()) > 0
    }, 'Settings open', 15_000)
    await click('settings-tab-about')
    await app.getByTestId('about-update-track').waitFor({ timeoutMs: 10_000 }).catch(async (error) => {
      await app.screenshot({ path: path.join(out, `failed-about-${theme}.png`) })
      throw error
    })
    await Bun.sleep(900)
  }
  const updateLabel = async () => (await app.getByTestId('about-update').textContent()) ?? ''
  return { app, click, about, updateLabel }
}

let exited = false
const first = await open('0.9.1')
try {
  const { app, click, about, updateLabel } = first
  assert.equal(await app.getByTestId('update-announcement').count(), 0, 'Stable must not be offered the dev build')
  await about()
  assert.match(await updateLabel(), /Check for updates/)
  await app.screenshot({ path: path.join(out, `about-stable-${theme}.png`) })
  console.log('ok  Stable: no update offered while the dev feed has 0.9.2-dev.1')

  await click('about-update-track-dev')
  await until(async () => /Update to 0\.9\.2-dev\.1/.test(await updateLabel()), 'Dev offers the dev build', 15_000)
  if (await app.getByTestId('update-announcement').count()) await click('update-announcement-dismiss')
  await Bun.sleep(700)
  await app.screenshot({ path: path.join(out, `about-dev-${theme}.png`) })
  console.log('ok  Dev: the dev build is offered right after switching')

  await click('about-update-track-stable')
  await until(async () => /Check for updates/.test(await updateLabel()), 'Stable drops the dev offer', 15_000)
  console.log('ok  back on Stable: the dev offer is gone')

  await click('about-update-track-dev')
  await until(async () => /Update to 0\.9\.2-dev\.1/.test(await updateLabel()), 'Dev offers it again', 15_000)
  await click('about-update')
  await until(() => version() === '0.9.2-dev.1', 'installed dev build', 30_000)
  exited = true
  console.log('ok  Dev: verified dev build installed into the scratch bundle (0.9.1 → 0.9.2-dev.1)')
} finally { if (!exited) await first.app.close().catch(() => {}) }

// The installed dev build, switched back to Stable: the older stable release is no update.
const second = await open('0.9.2-dev.1')
try {
  const { app, click, about, updateLabel } = second
  await about()
  await click('about-update-track-stable')
  await Bun.sleep(2500)
  assert.match(await updateLabel(), /Check for updates/, 'Stable must not offer 0.9.1 to 0.9.2-dev.1')
  assert.match((await app.getByTestId('page-settings').textContent()) ?? '', /Kybern stays on 0\.9\.2-dev\.1 until a stable release is newer\./)
  await app.screenshot({ path: path.join(out, `about-stable-on-dev-build-${theme}.png`) })
  assert.equal(version(), '0.9.2-dev.1')
  console.log('ok  Dev → Stable: stays on 0.9.2-dev.1, no downgrade offered')
} finally {
  await second.app.close().catch(() => {})
  stable.stop()
  dev.stop()
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
