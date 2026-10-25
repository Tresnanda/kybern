/**
 * Local macOS app for this Mac's arch, or `--arch x64|arm64`; ad-hoc signing only, no installation. On Linux, see `package-linux.ts`.
 * `--test` gives the bundle its own name and id (`Kybern GPUIX (x86_64 test)`, `dev.kybern.gpuix.test`),
 * so LaunchServices and system notifications never attribute a test build to the installed app.
 */
import { cpSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { COMPANION_CFLAGS } from './companion-flags.ts'
import { resourceUrlPlugin } from './resource-urls.ts'
const root = path.resolve(import.meta.dir, '..')
// Windows has its own pipeline (compiled app + NSIS installer); `--windows` cross-builds it from another OS.
if (process.platform === 'win32' || process.argv.includes('--windows')) { await import('./package-windows.ts'); process.exit(0) }
// Linux packs an AppImage, a .deb and an .rpm instead (`package-linux.ts`, same flags plus `--formats`).
if (process.platform === 'linux') { await import('./package-linux.ts'); process.exit(0) }
if (process.platform !== 'darwin') throw Error('Packaging requires macOS, Linux or Windows')
// The whole bundle is one arch: Bun's runtime, the addon, kybernd and kybern. The Objective-C companions are universal.
const archFlag = process.argv.indexOf('--arch')
const arch = archFlag >= 0 ? process.argv[archFlag + 1] : process.arch
if (arch !== 'arm64' && arch !== 'x64') throw Error(`Unsupported arch ${arch}; use --arch arm64 or --arch x64`)
const machArch = arch === 'arm64' ? 'arm64' : 'x86_64'
const test = process.argv.includes('--test')
const name = test ? `Kybern GPUIX (${machArch} test)` : 'Kybern GPUIX'
const app = path.join(root, `dist/${name}.app`)
const resources = path.join(app, 'Contents/Resources')
const macos = path.join(app, 'Contents/MacOS')
const addon = path.join(root, `native/build/gpuix-native.darwin-${arch}.node`)
if (!existsSync(addon)) throw Error(`Build the patched native addon for ${arch} first (native/README.md)`)
const archsOf = (file: string) => execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)
execFileSync('bun', [path.join(root, 'native/build-webview.ts')], { stdio: 'inherit' })
// Local packaging takes the debug daemon and CLI; releases point KYBERN_BIN_DIR at dist's release binaries.
const binDir = process.env.KYBERN_BIN_DIR ? path.resolve(process.env.KYBERN_BIN_DIR) : path.resolve(root, '../../target/debug')
const binaries = ['kybern', 'kybernd'].map(name => ({ name, source: path.join(binDir, name) }))
for (const { source } of binaries) {
  if (!existsSync(source)) throw Error(`Build this checkout's daemon and CLI before packaging: ${source}`)
  if (!archsOf(source).includes(machArch)) throw Error(`${source} is not built for ${machArch}; set KYBERN_BIN_DIR to the ${machArch} build`)
}
if (!archsOf(addon).includes(machArch)) throw Error(`${addon} is not built for ${machArch}`)
const version = /\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(root, '../../Cargo.toml'), 'utf8'))?.[1]
if (!version) throw Error('Missing workspace release version')
mkdirSync(resources, {recursive:true}); mkdirSync(macos, {recursive:true})
for (const { name, source } of binaries) cpSync(source, path.join(macos, name))
writeFileSync(path.join(resources, 'version'), version)
cpSync(path.join(root, 'packaging/Info.plist'), path.join(app, 'Contents/Info.plist'))
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, path.join(app, 'Contents/Info.plist')])
if (test) for (const set of ['CFBundleIdentifier dev.kybern.gpuix.test', `CFBundleName ${name}`, `CFBundleDisplayName ${name}`]) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${set}`, path.join(app, 'Contents/Info.plist')])
cpSync(path.join(root, '../desktop/src-tauri/icons/icon.icns'), path.join(resources, 'icon.icns'))
// The Icon Composer icon (`CFBundleIconName`): dark, clear and tinted appearances; `icon.icns` is the light fallback.
cpSync(path.join(root, '../desktop/src-tauri/icons/Assets.car'), path.join(resources, 'Assets.car'))
cpSync(addon, path.join(resources, path.basename(addon)))
cpSync(path.join(root, 'native/build/kybern-webview.dylib'), path.join(resources, 'kybern-webview.dylib'))
// Mermaid for transcript diagrams (`src/transcript/mermaid.ts` runs it in a hidden WKWebView).
cpSync(path.join(root, '../desktop/node_modules/mermaid/dist/mermaid.min.js'), path.join(resources, 'mermaid.min.js'))
cpSync(path.join(root, 'src/assets/fonts'), path.join(resources, 'src/assets/fonts'), {recursive:true})
cpSync(path.join(root, 'src/assets/providers'), path.join(resources, 'src/assets/providers'), {recursive:true})
// The release announcement's artwork (`platform/UpdateSurface.tsx`).
cpSync(path.join(root, '../desktop/public/release-background.png'), path.join(resources, 'release-background.png'))
// The ported window-translucency code carries its MIT notice (`THIRD_PARTY_NOTICES.md`).
cpSync(path.join(root, '../../THIRD_PARTY_NOTICES.md'), path.join(resources, 'THIRD_PARTY_NOTICES.md'))
const previousCwd = process.cwd()
const buildTemps = new Set(readdirSync(root).filter(name => name.endsWith('.bun-build')))
process.chdir(root)
let result: Awaited<ReturnType<typeof Bun.build>>
try {
result = await Bun.build({
  entrypoints: [path.join(root, 'packaging/entry.ts')], target: 'bun',
  // Production React: the development build records a performance entry per component render and never clears them.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  compile: {target:`bun-darwin-${arch}`, outfile:path.join(macos, 'Kybern GPUIX'), autoloadDotenv:false, autoloadBunfig:false, autoloadTsconfig:false, autoloadPackageJson:false},
  external: ['@gpuix/native-*'],
  plugins: [resourceUrlPlugin(root)],
})
} finally {
process.chdir(previousCwd)
for (const name of readdirSync(root)) if (name.endsWith('.bun-build') && !buildTemps.has(name)) rmSync(path.join(root, name))
}
if (!result.success) throw new AggregateError(result.logs, 'App compilation failed')
execFileSync('clang', ['-dynamiclib',...COMPANION_CFLAGS,'-framework','Cocoa','-framework','UserNotifications',path.join(root,'packaging/notifications.m'),'-o',path.join(resources,'notifications.dylib')], {stdio:'inherit'})
for (const file of [path.basename(addon), 'notifications.dylib', 'kybern-webview.dylib']) execFileSync('codesign',['--force','--sign','-',path.join(resources,file)],{stdio:'inherit'})
for (const { name } of binaries) execFileSync('codesign',['--force','--sign','-',path.join(macos,name)],{stdio:'inherit'})
execFileSync('codesign',['--force','--sign','-',app],{stdio:'inherit'})
execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'})
if (!archsOf(path.join(macos, 'Kybern GPUIX')).includes(machArch)) throw Error(`The compiled app is not ${machArch}`)
console.log(app)
