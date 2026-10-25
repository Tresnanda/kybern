// The updater's pure parts: signature checks (Tauri's minisign format), feed
// parsing (GPUIX's own platform key), and the bundle swap, on scratch folders.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appImageName } from './linuxPackage.ts'
import { verifyMinisign } from './minisign.ts'
import { assertSignedRelease, assertWindowsInstaller, manualUpdate, PLATFORM_KEY, platformKey, readFeed, removeStaleInstallers, replaceAppImage, replaceBundle, stageWindowsInstaller, windowsInstall, windowsInstallerCommand } from './update.ts'
import { archive, fakeBundle, testKey } from './verify.feed.ts'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

test('accepts a tauri-signed file and rejects tampering or another key', () => {
  const key = testKey(), other = testKey()
  const data = Buffer.from('kybern update payload')
  const signature = key.signFile(data, 'update.app.tar.gz')
  expect(verifyMinisign(data, signature, key.pubkey).trustedComment).toContain('file:update.app.tar.gz')
  expect(() => verifyMinisign(Buffer.from('kybern update payloaD'), signature, key.pubkey)).toThrow('does not match the download')
  expect(() => verifyMinisign(data, signature, other.pubkey)).toThrow('signed with a different key')
  // An edited trusted comment breaks the global signature.
  const lines = Buffer.from(signature, 'base64').toString().split('\n')
  lines[2] = 'trusted comment: timestamp:0\tfile:evil'
  expect(() => verifyMinisign(data, Buffer.from(lines.join('\n')).toString('base64'), key.pubkey)).toThrow('trusted comment was altered')
})

test('reads only the GPUIX platform entry and ignores older versions', async () => {
  const feed = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch
  const platforms = { 'darwin-aarch64': { url: 'https://example/desktop.tar.gz', signature: 's' } }
  expect(await readFeed('0.9.1', ['x'], feed({ version: '0.9.1', platforms }))).toBeNull()
  expect(await readFeed('0.9.1', ['x'], feed({ version: '0.9.2', platforms }))).toMatchObject({ version: '0.9.2', entry: null })
  const ours = await readFeed('0.9.1', ['x'], feed({ version: 'v0.9.2', notes: 'n', platforms: { ...platforms, [PLATFORM_KEY]: { url: 'https://example/gpuix.tar.gz', signature: 'g' } } }))
  expect(ours).toEqual({ version: '0.9.2', notes: 'n', entry: { url: 'https://example/gpuix.tar.gz', signature: 'g' } })
})

// The swap reads the new bundle's identifier with macOS's PlistBuddy, so this runs on macOS only.
test.skipIf(process.platform !== 'darwin')('swaps the bundle in place and refuses another app’s archive', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'kybern-update-'))
  const installed = fakeBundle(path.join(root, 'Applications'), '0.9.1')
  const next = fakeBundle(path.join(root, 'next'), '0.9.2')
  await replaceBundle(installed, archive(next, path.join(root, 'next.tar.gz')))
  expect(readFileSync(path.join(installed, 'Contents/Resources/version'), 'utf8')).toBe('0.9.2')
  // Nothing staged is left beside the app.
  expect(readdirSync(path.join(root, 'Applications'))).toEqual(['Kybern GPUIX.app'])
  const foreign = fakeBundle(path.join(root, 'foreign'), '9.9.9')
  writeFileSync(path.join(foreign, 'Contents/Info.plist'), readFileSync(path.join(foreign, 'Contents/Info.plist'), 'utf8').replace('dev.kybern.gpuix', 'dev.kybern.desktop'))
  await expect(replaceBundle(installed, archive(foreign, path.join(root, 'foreign.tar.gz')))).rejects.toThrow('The update is for dev.kybern.desktop, not this one')
  expect(readFileSync(path.join(installed, 'Contents/Resources/version'), 'utf8')).toBe('0.9.2')
})

test('each platform reads its own feed entry', () => {
  expect(platformKey('darwin', 'arm64')).toBe('darwin-aarch64-gpuix')
  expect(platformKey('darwin', 'x64')).toBe('darwin-x86_64-gpuix')
  expect(platformKey('win32', 'x64')).toBe('windows-x86_64-gpuix')
  expect(platformKey('linux', 'x64')).toBe('linux-x86_64-gpuix')
})

test('only an installed Windows copy updates itself', () => {
  const dir = 'C:\\Users\\me\\AppData\\Local\\Programs\\Kybern GPUIX'
  const installed = (file: string) => file === `${dir}\\uninstall.exe`
  expect(windowsInstall(`${dir}\\Kybern GPUIX.exe`, installed)).toBe(dir)
  // A loose copy has no uninstaller beside it; bun and other programs are never the app.
  expect(windowsInstall('C:\\Downloads\\Kybern GPUIX.exe', installed)).toBeNull()
  expect(windowsInstall(`${dir}\\bun.exe`, installed)).toBeNull()
})

test('a downloaded Windows installer is staged only if it is a PE file', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'kybern-update-'))
  const file = await stageWindowsInstaller(Buffer.from('MZ\x90\x00installer'), root)
  expect(path.dirname(path.dirname(file))).toBe(root)
  expect(readFileSync(file).subarray(0, 2).toString()).toBe('MZ')
  await expect(stageWindowsInstaller(Buffer.from('#!/bin/sh\nrm -rf ~'), root)).rejects.toThrow('not a Windows installer')
})

test('old staged installers are removed, recent ones and other folders are kept', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'kybern-update-'))
  const old = path.join(root, 'kybern-gpuix-update-old'), fresh = path.join(root, 'kybern-gpuix-update-new'), other = path.join(root, 'other')
  for (const dir of [old, fresh, other]) mkdirSync(dir)
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(old, longAgo, longAgo)
  utimesSync(other, longAgo, longAgo)
  await removeStaleInstallers(root)
  expect([old, fresh, other].map(existsSync)).toEqual([false, true, true])
})

test('a signed Windows installer must be this release’s GPUIX setup and newer than the running app', () => {
  const key = testKey(), data = Buffer.from('MZ installer')
  const comment = (file: string) => verifyMinisign(data, key.signFile(data, file), key.pubkey).trustedComment
  expect(() => assertWindowsInstaller(comment('kybern-gpuix_0.16.0_x64-setup.exe'), '0.16.0', '0.15.1')).not.toThrow()
  // Tauri's setup, an older GPUIX installer and the macOS archive all carry valid signatures from the same key.
  for (const file of ['Kybern_0.16.0_x64-setup.exe', 'kybern-gpuix_0.15.0_x64-setup.exe', 'kybern-gpuix_0.16.0_aarch64.app.tar.gz'])
    expect(() => assertWindowsInstaller(comment(file), '0.16.0', '0.15.1')).toThrow('Download it from the release page.')
  expect(() => assertWindowsInstaller('timestamp:1', '0.16.0', '0.15.1')).toThrow('not the build for this release')
  // The feed cannot talk the app into installing the version it already runs, or an older one.
  expect(() => assertWindowsInstaller(comment('kybern-gpuix_0.15.1_x64-setup.exe'), '0.15.1', '0.15.1')).toThrow('not newer')
  expect(() => assertWindowsInstaller(comment('kybern-gpuix_0.15.0_x64-setup.exe'), '0.15.0', '0.15.1')).toThrow('not newer')
})

test('the installer starts through Start-Process with an unquoted /D= folder last', () => {
  const { command, args } = windowsInstallerCommand("C:\\Users\\O'Brien\\Temp\\kybern-gpuix-update-x\\setup.exe", 'D:\\My Apps\\Kybern GPUIX\\', 'C:\\Windows')
  expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(args.at(-1)).toBe("Start-Process -FilePath 'C:\\Users\\O''Brien\\Temp\\kybern-gpuix-update-x\\setup.exe' -ArgumentList '/S /UPDATE /D=D:\\My Apps\\Kybern GPUIX'")
  expect(windowsInstallerCommand('C:\\s.exe', 'E:\\', 'C:\\Windows').args.at(-1)).toContain("/D=E:\\'")
})

/** The first bytes of a type 2 AppImage: an ELF header with `AI\x02` at offset 8. */
const appImage = (body: string) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.from(body)])

test('replaces a running AppImage in place and refuses other files', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'kybern-update-'))
  const image = path.join(root, 'Kybern-GPUIX-x86_64.AppImage')
  writeFileSync(image, appImage('0.9.1'))
  chmodSync(image, 0o700)
  const before = statSync(image).ino
  await replaceAppImage(image, appImage('0.9.2'), 'kybern-gpuix_0.9.2_x86_64.AppImage')
  expect(readFileSync(image).subarray(11).toString()).toBe('0.9.2')
  // A new file renamed over the old one: the mounted image keeps running from its own inode.
  expect(statSync(image).ino).not.toBe(before)
  expect(statSync(image).mode & 0o777).toBe(0o755)
  expect(readdirSync(root)).toEqual(['Kybern-GPUIX-x86_64.AppImage'])
  // The Tauri AppImage carries the same signing key; the signed file name tells them apart.
  await expect(replaceAppImage(image, appImage('9.9.9'), 'kybern-9.9.9-x86_64-unknown-linux-gnu.AppImage')).rejects.toThrow('not a Kybern GPUIX AppImage')
  await expect(replaceAppImage(image, Buffer.from('#!/bin/sh\necho hi\n'), 'kybern-gpuix_9.9.9_x86_64.AppImage')).rejects.toThrow('The update is not an AppImage')
  expect(readFileSync(image).subarray(11).toString()).toBe('0.9.2')
  expect(readdirSync(root)).toEqual(['Kybern-GPUIX-x86_64.AppImage'])
})

test('deb and rpm installs get the package beside the feed’s AppImage and its install command', () => {
  const entry = { url: 'https://github.com/o/r/releases/download/v0.9.2/kybern-gpuix_0.9.2_x86_64.AppImage', signature: 's' }
  expect(manualUpdate(entry, { kind: 'deb' })).toEqual({ url: 'https://github.com/o/r/releases/download/v0.9.2/kybern-gpuix_0.9.2_x86_64.deb', file: 'kybern-gpuix_0.9.2_x86_64.deb', command: 'sudo apt install ./kybern-gpuix_0.9.2_x86_64.deb' })
  expect(manualUpdate(entry, { kind: 'rpm' })?.url).toBe('https://github.com/o/r/releases/download/v0.9.2/kybern-gpuix_0.9.2_x86_64.rpm')
  expect(manualUpdate(entry, { kind: 'rpm' })?.command).toMatch(/^sudo (dnf|zypper) install .*\.\/kybern-gpuix_0\.9\.2_x86_64\.rpm$/)
  // An unpacked AppImage can only download the new one; a running AppImage and macOS install it themselves.
  expect(manualUpdate(entry, { kind: 'unpacked' })).toEqual({ url: entry.url, file: 'kybern-gpuix_0.9.2_x86_64.AppImage', command: null })
  expect(manualUpdate(entry, { kind: 'appimage', image: '/x.AppImage' })).toBeNull()
  expect(manualUpdate(entry, null)).toBeNull()
})

test('a signed AppImage must be this release’s GPUIX AppImage and newer than the running app', () => {
  const key = testKey(), data = Buffer.from('AppImage')
  const comment = (file: string) => verifyMinisign(data, key.signFile(data, file), key.pubkey).trustedComment
  expect(appImageName('0.16.0', 'x64')).toBe('kybern-gpuix_0.16.0_x86_64.AppImage')
  expect(() => assertSignedRelease(comment('kybern-gpuix_0.16.0_x86_64.AppImage'), appImageName('0.16.0', 'x64'), '0.16.0', '0.15.1')).not.toThrow()
  // Tauri's AppImage and an older GPUIX AppImage are signed with the same key.
  for (const file of ['kybern_0.16.0_amd64.AppImage', 'kybern-gpuix_0.15.0_x86_64.AppImage', 'kybern-gpuix_0.16.0_x64-setup.exe'])
    expect(() => assertSignedRelease(comment(file), appImageName('0.16.0', 'x64'), '0.16.0', '0.15.1')).toThrow('Download it from the release page.')
  expect(() => assertSignedRelease(comment('kybern-gpuix_0.15.1_x86_64.AppImage'), appImageName('0.15.1', 'x64'), '0.15.1', '0.15.1')).toThrow('not newer')
})
