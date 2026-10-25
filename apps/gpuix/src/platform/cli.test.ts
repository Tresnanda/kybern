// CLI install/uninstall against a scratch home, PATH and "system" bin: the
// `cli.rs` behaviours (target choice, refusing foreign files, stale links,
// shadowing, removing an older copy, the administrator path).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cliInstallKind, cliStatus, installCli, managedCliCopy, removeOtherCli, uninstallCli, type CliEnvironment } from './cli.ts'

let root = ''
let admin: string[] = []
const command = (file: string, output: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\necho '${output}'\n`); chmodSync(file, 0o755) }
function env(dirs: string[], systemBin = path.join(root, 'usr-local-bin')): CliEnvironment {
  return { bundled: path.join(root, 'Kybern GPUIX.app/Contents/MacOS/kybern'), home: path.join(root, 'home'), searchPath: async () => dirs, systemBin, adminRun: async (script) => { admin.push(script) } }
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kybern-cli-'))
  admin = []
  command(path.join(root, 'Kybern GPUIX.app/Contents/MacOS/kybern'), 'kybern 0.9.1')
  mkdirSync(path.join(root, 'home'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('links into ~/.local/bin when it is on PATH, and uninstalls only that link', async () => {
  const homeBin = path.join(root, 'home/.local/bin')
  const e = env([homeBin, '/usr/bin'])
  const before = await cliStatus(e)
  expect(before).toMatchObject({ method: 'link', installed: false, needs_admin: false, target: path.join(homeBin, 'kybern'), target_on_path: true, problem: null })
  const after = await installCli(e)
  expect(after.installed).toBe(true)
  expect(readlinkSync(path.join(homeBin, 'kybern'))).toBe(e.bundled!)
  expect(after.resolved_version).toBe('0.9.1')
  expect((await uninstallCli(e)).installed).toBe(false)
  expect(existsSync(path.join(homeBin, 'kybern'))).toBe(false)
})

// The administrator-prompt route is macOS's; Linux CI reports no need for it.
test.skipIf(process.platform !== 'darwin')('uses the system bin (administrator prompt) when ~/.local/bin is not on PATH', async () => {
  const system = path.join(root, 'locked-bin')
  mkdirSync(system); chmodSync(system, 0o555)
  const e = env(['/usr/bin'], system)
  const status = await cliStatus(e)
  expect(status).toMatchObject({ target: path.join(system, 'kybern'), needs_admin: true, target_on_path: false })
  await installCli(e)
  expect(admin).toHaveLength(1)
  expect(admin[0]).toContain(`/bin/ln -sfn '${e.bundled}' '${path.join(system, 'kybern')}'`)
  chmodSync(system, 0o755)
})

test('refuses to replace a command that is not Kybern’s', async () => {
  const homeBin = path.join(root, 'home/.local/bin')
  command(path.join(homeBin, 'kybern'), 'something else')
  await expect(installCli(env([homeBin]))).rejects.toThrow('already exists and isn’t Kybern’s command')
})

test('replaces a stale link left by a moved copy of the app', async () => {
  const homeBin = path.join(root, 'home/.local/bin')
  mkdirSync(homeBin, { recursive: true })
  symlinkSync('/nonexistent/Kybern.app/Contents/MacOS/kybern', path.join(homeBin, 'kybern'))
  expect((await installCli(env([homeBin]))).installed).toBe(true)
  expect(lstatSync(path.join(homeBin, 'kybern')).isSymbolicLink()).toBe(true)
})

test('reports a shadowing older copy and removes only a Kybern CLI', async () => {
  const homeBin = path.join(root, 'home/.local/bin'), cargo = path.join(root, 'home/.cargo/bin')
  command(path.join(cargo, 'kybern'), 'kybern 0.8.1')
  const e = env([cargo, homeBin])
  const installed = await installCli(e)
  expect(installed).toMatchObject({ installed: true, shadowed: true, resolved: path.join(cargo, 'kybern'), resolved_version: '0.8.1' })
  const cleaned = await removeOtherCli(path.join(cargo, 'kybern'), e)
  expect(cleaned).toMatchObject({ shadowed: false, resolved: path.join(homeBin, 'kybern') })
  command(path.join(cargo, 'kybern'), 'not ours')
  await expect(removeOtherCli(path.join(cargo, 'kybern'), e)).rejects.toThrow('isn’t a Kybern command, so Kybern left it in place')
})

test('a missing bundled command is a problem, not an install', async () => {
  const e = { ...env([]), bundled: null }
  expect((await cliStatus(e)).problem).toBe('This build of Kybern doesn’t include the kybern command.')
  await expect(installCli(e)).rejects.toThrow('doesn’t include the kybern command')
})

const ctx = (platform: NodeJS.Platform, env: Record<string, string> = {}) => ({ platform, env, home: '/home/ada' })
test('who owns the command per platform', () => {
  expect(cliInstallKind('/Applications/Kybern GPUIX.app/Contents/MacOS/kybern', ctx('darwin'))).toBe('link')
  expect(cliInstallKind('C:\\Users\\ada\\AppData\\Local\\Programs\\Kybern GPUIX\\kybern.exe', ctx('win32'))).toBe('installer')
  expect(cliInstallKind('/tmp/.mount_kybernX/usr/bin/kybern', ctx('linux', { APPIMAGE: '/home/ada/Kybern.AppImage' }))).toBe('appimage')
  expect(cliInstallKind('/usr/lib/kybern-gpuix/kybern', ctx('linux'), '/usr/lib/kybern-gpuix/Kybern GPUIX')).toBe('package')
  expect(cliInstallKind('/opt/kybern/kybern', ctx('linux'), '/opt/kybern/Kybern GPUIX')).toBe('package')
  expect(cliInstallKind('/home/ada/kybern-portable/kybern', ctx('linux'), '/home/ada/kybern-portable/Kybern GPUIX')).toBe('link')
  // A portable build on a machine that has the Tauri deb: its PATH holds /usr/bin/kybern, which is not this app's command.
  expect(cliInstallKind('/usr/bin/kybern', ctx('linux'), '/home/ada/kybern-portable/Kybern GPUIX')).toBe('link')
  // A development run is bun: the command's own location decides.
  expect(cliInstallKind('/home/ada/ade/target/debug/kybern', ctx('linux'), '/usr/local/bin/bun')).toBe('link')
  expect(managedCliCopy('installer')).toContain('installer')
  expect(managedCliCopy('package')).toContain('package manager')
  expect(managedCliCopy('link')).toBeNull()
})
test('a package or installer owns the command: reported, never installed or removed', async () => {
  const packaged: CliEnvironment = { ...env([path.join(root, 'usr-bin')]), kind: 'package', platform: 'linux' }
  command(path.join(root, 'usr-bin/kybern'), 'kybern 0.9.1')
  expect(await cliStatus(packaged)).toMatchObject({ method: 'package', installed: true, needs_admin: false, problem: null, target: path.join(root, 'usr-bin/kybern') })
  await expect(installCli(packaged)).rejects.toThrow('package manager')
  await expect(uninstallCli(packaged)).rejects.toThrow('package manager')
  const missing = await cliStatus({ ...env([path.join(root, 'nowhere')]), kind: 'installer', platform: 'win32' })
  expect(missing).toMatchObject({ method: 'path', installed: false })
  expect(missing.problem).toContain('PATH')
})
test('an AppImage links ~/.local/bin/kybern to the AppImage file, with no administrator step', async () => {
  const appImage = path.join(root, 'Kybern.AppImage')
  command(appImage, 'kybern 0.9.1')
  const homeBin = path.join(root, 'home/.local/bin')
  const e: CliEnvironment = { ...env([homeBin]), bundled: appImage, kind: 'appimage', platform: 'linux' }
  expect(await cliStatus(e)).toMatchObject({ method: 'link', installed: false, needs_admin: false, target: path.join(homeBin, 'kybern') })
  const after = await installCli(e)
  expect(after.installed).toBe(true)
  expect(readlinkSync(path.join(homeBin, 'kybern'))).toBe(appImage)
  expect(admin).toEqual([])
  expect((await uninstallCli(e)).installed).toBe(false)
})
test('off macOS the link target is the home bin even when it is not on PATH yet', async () => {
  const status = await cliStatus({ ...env(['/usr/bin']), kind: 'link', platform: 'linux' })
  expect(status).toMatchObject({ target: path.join(root, 'home/.local/bin/kybern'), needs_admin: false, target_on_path: false })
})
