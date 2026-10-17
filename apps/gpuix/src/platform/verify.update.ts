// The update flow in a real window, against a local signed feed and a scratch
// bundle (never the installed app): the announcement, "See what's new", the
// details dialog, the rail badge and its card, download progress, the verified
// install, and a tampered download that is refused and leaves the bundle alone.
//
//   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/platform/verify.update.ts <out-dir> [dark|light]
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { until } from './verify.lib.ts'
import { archive, fakeBundle, serveFeed, testKey } from './verify.feed.ts'

const out = process.argv[2] ?? '/tmp/update-check'
const theme = process.argv[3] ?? 'dark'
mkdirSync(out, { recursive: true })
const root = mkdtempSync(path.join(tmpdir(), 'kybern-update-ui-'))
const key = testKey()
const installed = fakeBundle(path.join(root, 'Applications'), '0.9.1')
const nextArchive = archive(fakeBundle(path.join(root, 'next'), '0.9.2', 6 * 1024 * 1024), path.join(root, 'next.tar.gz'))
const feed = await serveFeed({ version: '0.9.2', archive: nextArchive, signature: key.signFile(nextArchive, 'gpuix.app.tar.gz'), ms: 3000 })
const version = () => readFileSync(path.join(installed, 'Contents/Resources/version'), 'utf8')

async function run(tampered: boolean) {
  if (tampered) feed.set({ version: '0.9.2', archive: nextArchive, signature: key.signFile(Buffer.concat([nextArchive, Buffer.from('x')]), 'gpuix.app.tar.gz'), ms: 300 })
  const config = path.join(root, `client-${tampered ? 'tampered' : 'ok'}`)
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_CLIENT_CONFIG_DIR: config, KYBERN_GPUIX_VERSION: '0.9.1',
    KYBERN_UPDATE_FEED: feed.url, KYBERN_UPDATE_PUBKEY: key.pubkey, KYBERN_UPDATE_BUNDLE: installed,
    KYBERN_UPDATE_FIRST_CHECK_MS: '300', KYBERN_UPDATE_NO_RELAUNCH: '1',
  } })
  let exited = false
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await app.getByTestId('update-announcement').waitFor({ timeoutMs: 20_000 })
    if (!tampered) {
      await Bun.sleep(500)
      await app.screenshot({ path: path.join(out, `announcement-${theme}.png`) })
      await app.getByTestId('update-announcement-details').click()
      await app.getByTestId('update-details').waitFor({ timeoutMs: 5000 })
      await Bun.sleep(400)
      await app.screenshot({ path: path.join(out, `details-${theme}.png`) })
      await app.getByTestId('update-details-later').click()
      await until(async () => (await app.getByTestId('update-details').count()) === 0, 'details closed')
    } else {
      await app.getByTestId('update-announcement-dismiss').click()
    }
    await app.getByTestId('rail-update').click()
    await app.getByTestId('rail-update-card').waitFor({ timeoutMs: 5000 })
    await Bun.sleep(300)
    if (!tampered) await app.screenshot({ path: path.join(out, `rail-card-${theme}.png`) })
    await app.getByTestId('rail-update-install').click()
    if (!tampered) {
      // Mid-download: the card's button reads "Updating… N%".
      const label = await until(async () => {
        for (let n = 1; n < 100; n++) if (await app.getByText(`Updating… ${n}%`).count()) return `Updating… ${n}%`
        return null
      }, 'download progress', 10_000)
      console.log('progress label:', label)
      await app.screenshot({ path: path.join(out, `rail-progress-${theme}.png`) })
      // The app quits after installing (KYBERN_UPDATE_NO_RELAUNCH).
      await until(() => version() === '0.9.2', 'installed version', 20_000)
      exited = true
      console.log('ok  verified update installed into the scratch bundle (0.9.1 → 0.9.2)')
    } else {
      await app.getByTestId('toast-error').waitFor({ timeoutMs: 10_000 })
      await Bun.sleep(300)
      await app.screenshot({ path: path.join(out, `tampered-${theme}.png`) })
      assert.equal(version(), '0.9.2', 'a refused download must leave the bundle as it was')
      console.log('ok  tampered download refused; bundle unchanged')
    }
  } finally { if (!exited) await app.close().catch(() => {}) }
}

try {
  await run(false)
  await run(true)
} finally {
  feed.stop()
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
