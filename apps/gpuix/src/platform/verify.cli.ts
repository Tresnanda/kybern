// Settings › About › Terminal command in the packaged app, with a scratch home
// and PATH (never ~/.local/bin or /usr/local/bin): status, Install, the link
// into the bundle, "Open a new terminal window", Uninstall.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.cli.ts <scratch root> <out-dir> [dark|light]
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../packaging/harness.ts'
import { assertScratchDataDir, until } from './verify.lib.ts'

assertScratchDataDir()

const [root, out, theme = 'dark'] = process.argv.slice(2) as [string, string, string?]
assert.ok(root?.includes('ade-gpuix-scratch'), 'scratch root only')
mkdirSync(out, { recursive: true })
const home = path.join(root, 'home'), bin = path.join(home, '.local/bin'), target = path.join(bin, 'kybern')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const bundled = path.resolve(import.meta.dir, '../../dist/Kybern GPUIX.app/Contents/MacOS/kybern')
const { app, close } = await launchFixture('', { GPUIX_BACKGROUND: '1', HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: '', KYBERN_APPEARANCE: theme, KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'client') })
try {
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-tab-about').click()
  await app.getByText('Run Kybern from a terminal with kybern. It stays in step with the app.').waitFor({ timeoutMs: 15_000 })
  await Bun.sleep(600)
  await app.screenshot({ path: path.join(out, `about-before-${theme}.png`) })
  await app.getByTestId('cli-install').click()
  await app.getByTestId('cli-uninstall').waitFor({ timeoutMs: 10_000 })
  assert.equal(readlinkSync(target), bundled)
  await app.getByText(`Installed at ~/.local/bin/kybern. It updates with the app.`).waitFor({ timeoutMs: 5000 })
  await app.getByText('Open a new terminal window to use it.').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(400)
  await app.screenshot({ path: path.join(out, `about-installed-${theme}.png`) })
  console.log(`ok  installed ${target} -> ${readlinkSync(target)}`)
  await app.getByTestId('cli-uninstall').click()
  await until(() => !existsSync(target), 'link removed')
  await app.getByTestId('cli-install').waitFor({ timeoutMs: 5000 })
  console.log('ok  uninstall removed only the scratch link')
} finally { await close() }
rmSync(home, { recursive: true, force: true })
process.exit(0)
