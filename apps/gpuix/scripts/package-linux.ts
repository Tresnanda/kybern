/**
 * Linux packages of Kybern GPUIX, run by `package-app.ts` on Linux: `--arch x64` (the release) or `--arch arm64`
 * (local container checks; defaults to this machine). One app folder (`kybern-gpuix`, `kybernd`, `kybern`,
 * `resources/`) is packed three ways into `dist/`:
 *
 *   kybern-gpuix_<version>_<x86_64|aarch64>.AppImage  self-updating (`src/platform/update.ts`); needs APPIMAGETOOL
 *                                                     and APPIMAGE_RUNTIME (type2-runtime) or both on PATH
 *   kybern-gpuix_<version>_<x86_64|aarch64>.deb       dpkg-deb; Depends from dpkg-shlibdeps
 *   kybern-gpuix_<version>_<x86_64|aarch64>.rpm       rpmbuild; Requires generated from the ELF files
 *
 * `--formats appimage,deb,rpm` picks a subset. deb and rpm install the folder as /usr/lib/kybern-gpuix, with
 * /usr/bin/kybern-gpuix, the `dev.kybern.gpuix` desktop entry and icons. Neither puts `kybern` or `kybernd` on
 * PATH: the Tauri package owns /usr/bin/kybern and /usr/bin/kybernd, and the two install side by side.
 * Each tree records its format in `resources/package` (`src/platform/linuxPackage.ts`).
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resourceUrlPlugin } from './resource-urls.ts'
const root = path.resolve(import.meta.dir, '..')
if (process.platform !== 'linux') throw Error('Linux packaging runs on Linux')
const archFlag = process.argv.indexOf('--arch')
const arch = archFlag >= 0 ? process.argv[archFlag + 1] : process.arch
if (arch !== 'x64' && arch !== 'arm64') throw Error(`Unsupported arch ${arch}; use --arch x64 or --arch arm64`)
const formatsFlag = process.argv.indexOf('--formats')
const formats = new Set(formatsFlag >= 0 ? process.argv[formatsFlag + 1]!.split(',') : ['appimage', 'deb', 'rpm'])
for (const format of formats) if (!['appimage', 'deb', 'rpm'].includes(format)) throw Error(`Unknown format ${format}; use appimage, deb or rpm`)
const machine = arch === 'x64' ? 'x86_64' : 'aarch64'
const debArch = arch === 'x64' ? 'amd64' : 'arm64'
const APP_ID = 'dev.kybern.gpuix'
const PACKAGE = 'kybern-gpuix'
const SUMMARY = 'Kybern GPUIX, the native desktop client for Kybern coding agents (beta)'

// e_machine in the ELF header: every binary in the package must be this arch.
const ELF_MACHINE = { x86_64: 62, aarch64: 183 }[machine]
function elfMachine(file: string) {
  const header = readFileSync(file).subarray(0, 20)
  if (header.readUInt32BE(0) !== 0x7f454c46) throw Error(`${file} is not an ELF file`)
  return header.readUInt16LE(18)
}
const requireArch = (file: string) => { if (elfMachine(file) !== ELF_MACHINE) throw Error(`${file} is not built for ${machine}`) }

const addon = path.join(root, `native/build/gpuix-native.linux-${arch}-gnu.node`)
if (!existsSync(addon)) throw Error(`Build the patched native addon for linux-${arch} first (native/update.sh)`)
requireArch(addon)
// Local packaging takes the debug daemon and CLI; releases point KYBERN_BIN_DIR at dist's static musl binaries.
const binDir = process.env.KYBERN_BIN_DIR ? path.resolve(process.env.KYBERN_BIN_DIR) : path.resolve(root, '../../target/debug')
for (const name of ['kybernd', 'kybern']) {
  const file = path.join(binDir, name)
  if (!existsSync(file)) throw Error(`Build this checkout's daemon and CLI before packaging: ${file}`)
  requireArch(file)
}
const version = /\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(root, '../../Cargo.toml'), 'utf8'))?.[1]
if (!version) throw Error('Missing workspace release version')
// deb and rpm sort `~` before the release it precedes, like semver's `-`.
const packageVersion = version.replace(/-/g, '~')
const out = path.join(root, 'dist')
const work = path.join(out, 'linux')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options })
const tool = (name: string) => { try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || null } catch { return null } }

// The app folder every format installs.
const app = path.join(work, 'app')
const resources = path.join(app, 'resources')
mkdirSync(resources, { recursive: true })
for (const name of ['kybernd', 'kybern']) { cpSync(path.join(binDir, name), path.join(app, name)); chmodSync(path.join(app, name), 0o755) }
writeFileSync(path.join(resources, 'version'), version)
cpSync(addon, path.join(resources, path.basename(addon)))
// WP10: the embedded web view. `libkybern-webview.so` (native/build-webview.ts, RUNPATH $ORIGIN/wpe/lib) and the
// private WPE WebKit from native/wpe/build-wpe.sh (built on the ubuntu-22.04 floor) go into resources/wpe with its
// licences and source offer. The web-process sandbox uses the system's bwrap and xdg-dbus-proxy (Recommends below);
// without them, or without the files here (KYBERN_REQUIRE_WEBVIEW=1 makes that an error), pages open in the browser.
const companion = path.join(root, 'native/build/libkybern-webview.so')
const wpe = process.env.KYBERN_WPE_PREFIX ? path.resolve(process.env.KYBERN_WPE_PREFIX) : path.join(root, 'native/build/wpe')
const webView = existsSync(companion) && existsSync(path.join(wpe, 'lib/libWPEWebKit-2.0.so.1'))
if (webView) {
  requireArch(companion)
  requireArch(path.join(wpe, 'lib/libWPEWebKit-2.0.so.1'))
  cpSync(companion, path.join(resources, 'libkybern-webview.so'))
  cpSync(path.join(wpe, 'lib'), path.join(resources, 'wpe/lib'), { recursive: true, filter: source => !source.includes(`${path.sep}pkgconfig`) })
  cpSync(path.join(wpe, 'share/licenses'), path.join(resources, 'wpe/licenses'), { recursive: true })
  cpSync(path.join(wpe, 'SOURCES.txt'), path.join(resources, 'wpe/SOURCES.txt'))
} else if (process.env.KYBERN_REQUIRE_WEBVIEW === '1') {
  throw Error(`Build the web view first (native/wpe/build-wpe.sh, then bun native/build-webview.ts): ${companion}`)
} else {
  console.warn('Packaging without the embedded web view (no native/build/libkybern-webview.so or WPE): previews open in the browser')
}
// Mermaid ships for parity with macOS; off macOS it needs the web view that WP4/WP10 brings (diagrams show as text).
cpSync(path.join(root, '../desktop/node_modules/mermaid/dist/mermaid.min.js'), path.join(resources, 'mermaid.min.js'))
cpSync(path.join(root, 'src/assets/fonts'), path.join(resources, 'src/assets/fonts'), { recursive: true })
cpSync(path.join(root, 'src/assets/providers'), path.join(resources, 'src/assets/providers'), { recursive: true })
cpSync(path.join(root, 'src/assets/release-artwork.jpg'), path.join(resources, 'src/assets/release-artwork.jpg'))
cpSync(path.join(root, 'src/assets/release-artwork-card.jpg'), path.join(resources, 'src/assets/release-artwork-card.jpg'))
cpSync(path.join(root, '../desktop/public/release-background.png'), path.join(resources, 'release-background.png'))
cpSync(path.join(root, '../../THIRD_PARTY_NOTICES.md'), path.join(resources, 'THIRD_PARTY_NOTICES.md'))
cpSync(path.join(root, '../../LICENSE'), path.join(resources, 'LICENSE'))

const executable = path.join(app, PACKAGE)
// x64 uses Bun's baseline build, which needs no AVX2 (Bun's default x64 build does, and crashes with an illegal instruction
// on older Intel/AMD CPUs and some virtual machines). The addon is plain x86-64: nothing in its build sets a target CPU.
const bunTarget = arch === 'x64' ? 'bun-linux-x64-baseline' : 'bun-linux-arm64'
const buildTemps = new Set(readdirSync(root).filter(name => name.endsWith('.bun-build')))
const previousCwd = process.cwd()
process.chdir(root)
let result: Awaited<ReturnType<typeof Bun.build>>
try {
  result = await Bun.build({
    entrypoints: [path.join(root, 'packaging/entry-linux.ts')], target: 'bun',
    // Production React: the development build records a performance entry per component render and never clears them.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    compile: { target: bunTarget, outfile: executable, autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
    external: ['@gpuix/native-*'],
    plugins: [resourceUrlPlugin(root, { appId: APP_ID })],
  })
} finally {
  process.chdir(previousCwd)
  for (const name of readdirSync(root)) if (name.endsWith('.bun-build') && !buildTemps.has(name)) rmSync(path.join(root, name))
}
if (!result.success) throw new AggregateError(result.logs, 'App compilation failed')
requireArch(executable)

const desktopEntry = `[Desktop Entry]
Type=Application
Name=Kybern GPUIX
GenericName=Coding agent workspace
Comment=Run and review coding agents (native client, beta)
Exec=${PACKAGE}
Icon=${APP_ID}
Terminal=false
Categories=Development;
Keywords=agent;claude;codex;ai;
StartupWMClass=${APP_ID}
`
// The addon dlopens these, so neither dpkg-shlibdeps nor rpmbuild sees them: wgpu's Vulkan loader (required;
// Fedora vulkan-loader, openSUSE libvulkan1), and GPUI's Wayland client plus EGL for wgpu's GL fallback, which
// every Wayland or GL desktop already has. Mesa's Vulkan drivers are what most machines render with.
// The web view's WPE loads EGL and GLES through libepoxy even when it renders on the CPU; its web process aborts or
// never draws without them (seen on a bare Ubuntu 24.04).
const RUNTIME_LIBRARIES = {
  deb: ['libvulkan1', ...(webView ? ['libegl1', 'libgles2'] : [])],
  rpm: ['libvulkan.so.1()(64bit)', ...(webView ? ['libEGL.so.1()(64bit)', 'libGLESv2.so.2()(64bit)'] : [])],
}
const RUNTIME_RECOMMENDS = {
  deb: ['libwayland-client0', 'libwayland-egl1', 'libegl1', 'mesa-vulkan-drivers', 'xdg-utils', ...(webView ? ['bubblewrap', 'xdg-dbus-proxy'] : [])],
  rpm: ['libwayland-client.so.0()(64bit)', 'libwayland-egl.so.1()(64bit)', 'libEGL.so.1()(64bit)', 'mesa-vulkan-drivers', 'xdg-utils', ...(webView ? ['bubblewrap', 'xdg-dbus-proxy'] : [])],
}
const icons = { 32: '32x32.png', 128: '128x128.png', 256: '128x128@2x.png', 512: 'icon.png' } as const
const iconSource = (file: string) => path.join(root, '../desktop/src-tauri/icons', file)

/** The FHS tree the deb and rpm install: the app folder, its launcher link, the desktop entry and icons. */
function systemTree(format: 'deb' | 'rpm') {
  const tree = path.join(work, `${format}-root`)
  cpSync(app, path.join(tree, `usr/lib/${PACKAGE}`), { recursive: true })
  writeFileSync(path.join(tree, `usr/lib/${PACKAGE}/resources/package`), `${format}\n`)
  mkdirSync(path.join(tree, 'usr/bin'), { recursive: true })
  symlinkSync(`../lib/${PACKAGE}/${PACKAGE}`, path.join(tree, `usr/bin/${PACKAGE}`))
  mkdirSync(path.join(tree, 'usr/share/applications'), { recursive: true })
  writeFileSync(path.join(tree, `usr/share/applications/${APP_ID}.desktop`), desktopEntry)
  for (const [size, file] of Object.entries(icons)) {
    const dir = path.join(tree, `usr/share/icons/hicolor/${size}x${size}/apps`)
    mkdirSync(dir, { recursive: true })
    cpSync(iconSource(file), path.join(dir, `${APP_ID}.png`))
  }
  return tree
}
const sizeKiB = (dir: string): number => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).reduce((total, entry) => total + statSync(path.join(entry.parentPath, entry.name)).size, 0) / 1024

const desktopFileValidate = tool('desktop-file-validate')
if (desktopFileValidate) {
  writeFileSync(path.join(work, `${APP_ID}.desktop`), desktopEntry)
  run(desktopFileValidate, [path.join(work, `${APP_ID}.desktop`)])
}
const outputs: string[] = []
const output = (extension: string) => path.join(out, `${PACKAGE}_${version}_${machine}.${extension}`)

if (formats.has('appimage')) {
  const appimagetool = process.env.APPIMAGETOOL || tool('appimagetool')
  const runtime = process.env.APPIMAGE_RUNTIME
  if (!appimagetool) throw Error('Set APPIMAGETOOL to appimagetool (github.com/AppImage/appimagetool), or pass --formats deb,rpm')
  if (!runtime || !existsSync(runtime)) throw Error(`Set APPIMAGE_RUNTIME to the type2-runtime for ${machine} (github.com/AppImage/type2-runtime); appimagetool would download an unpinned one`)
  const appDir = path.join(work, 'AppDir')
  cpSync(app, path.join(appDir, `usr/lib/${PACKAGE}`), { recursive: true })
  writeFileSync(path.join(appDir, `usr/lib/${PACKAGE}/resources/package`), 'appimage\n')
  // Started as `kybern` (a `~/.local/bin/kybern` link to the image, `platform/cli.ts`), it runs the CLI instead of the app.
  writeFileSync(path.join(appDir, 'AppRun'), `#!/bin/sh\n# The runtime mounts the image and sets APPDIR, APPIMAGE and ARGV0 (packaging/entry-linux.ts reads them).\nHERE="$(dirname "$(readlink -f "$0")")"\nif [ "$(basename "\${ARGV0:-$0}")" = kybern ]; then exec "$HERE/usr/lib/${PACKAGE}/kybern" "$@"; fi\nexec "$HERE/usr/lib/${PACKAGE}/${PACKAGE}" "$@"\n`)
  chmodSync(path.join(appDir, 'AppRun'), 0o755)
  writeFileSync(path.join(appDir, `${APP_ID}.desktop`), desktopEntry)
  cpSync(iconSource(icons[256]), path.join(appDir, `${APP_ID}.png`))
  symlinkSync(`${APP_ID}.png`, path.join(appDir, '.DirIcon'))
  const file = output('AppImage')
  rmSync(file, { force: true })
  // appimagetool is itself an AppImage; CI runners and containers have no FUSE.
  run(appimagetool, ['--no-appstream', '--runtime-file', runtime, appDir, file], { env: { ...process.env, ARCH: machine, APPIMAGE_EXTRACT_AND_RUN: '1' } })
  outputs.push(file)
}

if (formats.has('deb')) {
  const tree = systemTree('deb')
  // dpkg-shlibdeps reads every NEEDED library of the ELF files and names the packages (and minimum versions) that
  // provide them on the build machine; ubuntu-22.04 in CI, the same glibc floor as the Tauri AppImage. It needs a
  // debian/control to run against. kybernd and kybern are static and have none.
  const scratch = path.join(work, 'shlibdeps')
  mkdirSync(path.join(scratch, 'debian'), { recursive: true })
  writeFileSync(path.join(scratch, 'debian/control'), `Source: ${PACKAGE}\n\nPackage: ${PACKAGE}\nArchitecture: any\n`)
  const lib = path.join(tree, `usr/lib/${PACKAGE}`)
  // The private WPE: its libraries resolve from resources/wpe/lib (-l), so only the system ones it links become Depends.
  // DEBIAN/ must exist first: it marks the package root, so dpkg-shlibdeps sees resources/wpe/lib as a private
  // directory (and resolves $ORIGIN) instead of failing on libraries no package provides.
  mkdirSync(path.join(tree, 'DEBIAN'), { recursive: true })
  const wpeLib = path.join(lib, 'resources/wpe/lib')
  const webViewFiles = webView ? [path.join(lib, 'resources/libkybern-webview.so'), ...readdirSync(wpeLib, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.so(\.|$)|Process$/.test(entry.name)).map(entry => path.join(entry.parentPath, entry.name))] : []
  const shlibs = execFileSync('dpkg-shlibdeps', ['-O', ...(webView ? [`-l${wpeLib}`] : []), `-e${path.join(lib, PACKAGE)}`, `-e${path.join(lib, 'resources', path.basename(addon))}`, ...webViewFiles.map(file => `-e${file}`)], { cwd: scratch, encoding: 'utf8' })
  const detected = /shlibs:Depends=(.*)/.exec(shlibs)?.[1]?.trim()
  if (!detected) throw Error(`dpkg-shlibdeps found no dependencies:\n${shlibs}`)
  const depends = [detected, ...RUNTIME_LIBRARIES.deb].join(', ')
  writeFileSync(path.join(tree, 'DEBIAN/control'), [
    `Package: ${PACKAGE}`, `Version: ${packageVersion}`, `Architecture: ${debArch}`, 'Maintainer: kybern',
    `Installed-Size: ${Math.ceil(sizeKiB(tree))}`, `Depends: ${depends}`, `Recommends: ${RUNTIME_RECOMMENDS.deb.join(', ')}`,
    'Section: devel', 'Priority: optional', 'Homepage: https://github.com/Tresnanda/kybern',
    `Description: ${SUMMARY}`,
    ' The GPUI client for Kybern, installed beside the Tauri desktop app (package kybern).',
    ' It bundles its own kybernd and kybern under /usr/lib/kybern-gpuix and puts only',
    ' kybern-gpuix on PATH.', '',
  ].join('\n'))
  if (webView) {
    // Ubuntu 23.10+ refuses unprivileged user namespaces to /usr/bin/bwrap; the profile lets Kybern's own copy create
    // the web-process sandbox there (the companion falls back to it). Written only where AppArmor 4 exists.
    const bwrap = `/usr/lib/${PACKAGE}/resources/wpe/lib/wpe-webkit-2.0/bwrap`
    const profile = readFileSync(path.join(root, 'packaging/linux/kybern-gpuix-bwrap.apparmor'), 'utf8').replace('@BWRAP@', bwrap)
    const file = '/etc/apparmor.d/kybern-gpuix-bwrap'
    writeFileSync(path.join(tree, 'DEBIAN/postinst'), `#!/bin/sh\nset -e\nif [ "$1" = configure ] && [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then\n  cat > ${file} <<'PROFILE'\n${profile}PROFILE\n  apparmor_parser -r -T -W ${file} || true\nfi\n`)
    writeFileSync(path.join(tree, 'DEBIAN/postrm'), `#!/bin/sh\nset -e\nif [ "$1" = remove ] || [ "$1" = purge ]; then\n  if [ -e ${file} ]; then apparmor_parser -R ${file} 2>/dev/null || true; rm -f ${file}; fi\nfi\n`)
    chmodSync(path.join(tree, 'DEBIAN/postinst'), 0o755)
    chmodSync(path.join(tree, 'DEBIAN/postrm'), 0o755)
  }
  const file = output('deb')
  rmSync(file, { force: true })
  run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', tree, file])
  outputs.push(file)
}

if (formats.has('rpm')) {
  const tree = systemTree('rpm')
  const top = path.join(work, 'rpmbuild')
  mkdirSync(path.join(top, 'SPECS'), { recursive: true })
  const spec = path.join(top, 'SPECS', `${PACKAGE}.spec`)
  writeFileSync(spec, `# Written by apps/gpuix/scripts/package-linux.ts from an already built tree.
# No strip or other post-install processing: the Bun executable carries the app after its ELF image.
%global __os_install_post %{nil}
%global debug_package %{nil}
%global _build_id_links none
Name: ${PACKAGE}
Version: ${packageVersion}
Release: 1
Summary: ${SUMMARY}
License: MIT
URL: https://github.com/Tresnanda/kybern
# Requires come from the ELF files (soname form, so the same rpm resolves on Fedora, RHEL and openSUSE).
# Nothing here is a library for other packages. The web view's private WPE (resources/wpe) and the companion link
# libraries shipped beside them, so their requirements are left out; the system ones they need are on every desktop.
AutoProv: no
%global __requires_exclude_from ^/usr/lib/${PACKAGE}/resources/(wpe/.*|libkybern-webview\\.so)$
# Loaded at run time, so no ELF file names them (see RUNTIME_LIBRARIES in package-linux.ts).
${RUNTIME_LIBRARIES.rpm.map(name => `Requires: ${name}`).join('\n')}
${RUNTIME_RECOMMENDS.rpm.map(name => `Recommends: ${name}`).join('\n')}

%description
The GPUI client for Kybern, installed beside the Tauri desktop app (package kybern).
It bundles its own kybernd and kybern under /usr/lib/kybern-gpuix and puts only
kybern-gpuix on PATH.

%install
cp -a ${tree}/. %{buildroot}/

%files
/usr/lib/${PACKAGE}
/usr/bin/${PACKAGE}
/usr/share/applications/${APP_ID}.desktop
${Object.keys(icons).map(size => `/usr/share/icons/hicolor/${size}x${size}/apps/${APP_ID}.png`).join('\n')}
`)
  run('rpmbuild', ['-bb', '--target', machine, '--define', `_topdir ${top}`, spec])
  const built = path.join(top, 'RPMS', machine, `${PACKAGE}-${packageVersion}-1.${machine}.rpm`)
  if (!existsSync(built)) throw Error(`rpmbuild did not write ${built}`)
  const file = output('rpm')
  cpSync(built, file)
  outputs.push(file)
}

for (const file of outputs) console.log(file)
