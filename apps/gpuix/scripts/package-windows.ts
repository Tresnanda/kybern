/**
 * Kybern GPUIX for Windows x64: a compiled Bun app and its per-user NSIS installer
 * (`packaging/windows/installer.nsi`). `package-app.ts` dispatches here on Windows, or
 * with `--windows` to cross-build from macOS or Linux (a build test; the icon and the
 * file properties need Windows APIs, so only a Windows run sets them).
 *
 *   bun scripts/package-windows.ts [--out <dir>] [--addon <file>] [--makensis <path>]
 *                                  [--no-installer] [--no-vc-runtime] [--nsis-ansi]
 *                                  [--webview <dll>] [--no-webview]
 *                                  [--webview2-bootstrapper <exe>] [--no-webview2-bootstrapper]
 *
 * Inputs: the patched addon (`native/build/gpuix-native.win32-x64-msvc.node`) and the
 * WebView2 host (`native/build/kybern-webview.dll`), both from `native/update.sh` on
 * Windows, `kybernd.exe` and `kybern.exe` in KYBERN_BIN_DIR (default `target/release`),
 * and `makensis` on PATH (NSIS 3). The installer carries Microsoft's Evergreen WebView2
 * bootstrapper, pinned by SHA-256 in `packaging/windows/webview2.ts` and cached between
 * builds (Windows also checks its Microsoft signature); a given copy is checked the same
 * way. It runs only on machines without the runtime. `--no-webview` (a cross-build) leaves
 * the host out, and the app then opens pages in the browser. Output: `<out>/payload`
 * (the app folder, default `dist/windows`) and `<out>/kybern-gpuix_<version>_x64-setup.exe`.
 * Nothing is installed, signed or run; `scripts/bundle-gpuix-windows.sh` signs the installer.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resourceUrlPlugin } from './resource-urls.ts'
import { installerName, nsisIncludes, VC_RUNTIME_DLLS, vcRuntimeCandidates, versionQuad } from '../packaging/windows/lib.ts'
import { webView2Bootstrapper } from '../packaging/windows/webview2.ts'

const root = path.resolve(import.meta.dir, '..')
const flag = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined }
const has = (name: string) => process.argv.includes(name)
const native = process.platform === 'win32'
if (process.arch !== 'x64' && native) throw Error('Kybern GPUIX for Windows is x64 only')

const version = /\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(root, '../../Cargo.toml'), 'utf8'))?.[1]
if (!version) throw Error('Missing workspace release version')
const out = path.resolve(flag('--out') ?? path.join(root, 'dist/windows'))
const payload = path.join(out, 'payload')
const addon = path.resolve(flag('--addon') ?? path.join(root, 'native/build/gpuix-native.win32-x64-msvc.node'))
const binDir = process.env.KYBERN_BIN_DIR ? path.resolve(process.env.KYBERN_BIN_DIR) : path.resolve(root, '../../target/release')
const binaries = ['kybernd.exe', 'kybern.exe'].map(name => ({ name, source: path.join(binDir, name) }))
const icon = path.join(root, '../desktop/src-tauri/icons/icon.ico')
const webview = has('--no-webview') ? undefined : path.resolve(flag('--webview') ?? path.join(root, 'native/build/kybern-webview.dll'))

if (!existsSync(addon)) throw Error(`Build the patched native addon for Windows first (native/update.sh on Windows): ${addon}`)
if (webview && !existsSync(webview)) throw Error(`Build the WebView2 host for Windows first (native/update.sh on Windows), or pass --no-webview: ${webview}`)
for (const { source } of binaries) if (!existsSync(source)) throw Error(`Windows kybernd.exe and kybern.exe are needed in ${binDir} (set KYBERN_BIN_DIR): ${source}`)

rmSync(out, { recursive: true, force: true })
mkdirSync(payload, { recursive: true })

// Everything the app needs sits in one flat folder beside the executable (`packaging/entry-windows.ts`).
// `kybern.exe` is alone in `bin`, the only folder the installer puts on the user's Path; `uninstall.exe`,
// `kybernd.exe` and the runtime DLLs stay out of the user's command namespace.
for (const { name, source } of binaries) cpSync(source, path.join(payload, name === 'kybern.exe' ? 'bin' : '.', name))
cpSync(addon, path.join(payload, 'gpuix-native.win32-x64-msvc.node'))
// The embedded web view (`src/native/webview.ts` loads it from KYBERN_GPUIX_RESOURCES, this folder).
if (webview) cpSync(webview, path.join(payload, 'kybern-webview.dll'))
// Mermaid for transcript diagrams (`src/transcript/mermaid.ts` runs it in a hidden web view document).
if (webview) cpSync(path.join(root, '../desktop/node_modules/mermaid/dist/mermaid.min.js'), path.join(payload, 'mermaid.min.js'))
writeFileSync(path.join(payload, 'version'), version)
cpSync(icon, path.join(payload, 'icon.ico'))
cpSync(path.join(root, 'src/assets/fonts'), path.join(payload, 'src/assets/fonts'), { recursive: true })
cpSync(path.join(root, 'src/assets/providers'), path.join(payload, 'src/assets/providers'), { recursive: true })
cpSync(path.join(root, 'src/assets/release-artwork.jpg'), path.join(payload, 'src/assets/release-artwork.jpg'))
cpSync(path.join(root, 'src/assets/release-artwork-card.jpg'), path.join(payload, 'src/assets/release-artwork-card.jpg'))
// The release announcement's artwork (`platform/UpdateSurface.tsx`).
cpSync(path.join(root, '../desktop/public/release-background.png'), path.join(payload, 'release-background.png'))
cpSync(path.join(root, '../../THIRD_PARTY_NOTICES.md'), path.join(payload, 'THIRD_PARTY_NOTICES.md'))
// The installer's helpers: the Path edit, the AppUserModelID shortcut and the process stop.
cpSync(path.join(root, 'packaging/windows/path.ps1'), path.join(payload, 'tools/path.ps1'))
cpSync(path.join(root, 'packaging/windows/shortcut.ps1'), path.join(payload, 'tools/shortcut.ps1'))
cpSync(path.join(root, 'packaging/windows/stop.ps1'), path.join(payload, 'tools/stop.ps1'))

if (!has('--no-vc-runtime')) copyVcRuntime()

const previousCwd = process.cwd()
const buildTemps = new Set(readdirSync(root).filter(name => name.endsWith('.bun-build')))
process.chdir(root)
let result: Awaited<ReturnType<typeof Bun.build>>
try {
  result = await Bun.build({
    entrypoints: [path.join(root, 'packaging/entry-windows.ts')], target: 'bun',
    // Production React: the development build records a performance entry per component render and never clears them.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    compile: {
      target: 'bun-windows-x64', outfile: path.join(payload, 'Kybern GPUIX.exe'),
      autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false,
      // A GUI app: no console window behind it. Icon and file properties are Windows-only calls.
      windows: {
        hideConsole: true,
        ...(native ? { icon, title: 'Kybern GPUIX', publisher: 'Kybern', version: versionQuad(version), description: 'Kybern GPUIX', copyright: 'Kybern' } : {}),
      },
    },
    external: ['@gpuix/native-*'],
    plugins: [resourceUrlPlugin(root)],
  })
} finally {
  process.chdir(previousCwd)
  for (const name of readdirSync(root)) if (name.endsWith('.bun-build') && !buildTemps.has(name)) rmSync(path.join(root, name))
}
if (!result.success) throw new AggregateError(result.logs, 'App compilation failed')

const entries = readdirSync(payload, { withFileTypes: true }).map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
console.log(`payload: ${payload} (${entries.length} entries)`)
if (has('--no-installer')) process.exit(0)

const installer = path.join(out, installerName(version))
const generated = path.join(out, 'nsis')
mkdirSync(generated, { recursive: true })
const { install, uninstall } = nsisIncludes(entries, payload)
writeFileSync(path.join(generated, 'install-files.nsh'), install)
writeFileSync(path.join(generated, 'uninstall-files.nsh'), uninstall)
const bootstrapper = has('--no-webview2-bootstrapper') || has('--no-webview') ? undefined
  : await webView2Bootstrapper({ given: flag('--webview2-bootstrapper'), verify: native })
const makensis = flag('--makensis') ?? process.env.MAKENSIS ?? (native ? 'makensis.exe' : 'makensis')
execFileSync(makensis, [
  '-V2', ...(has('--nsis-ansi') ? ['-DANSI'] : []), ...(bootstrapper ? [`-DWEBVIEW2_BOOTSTRAPPER=${bootstrapper}`] : []),
  `-DAPP_VERSION=${version}`, `-DVERSION_QUAD=${versionQuad(version)}`,
  `-DPAYLOAD_DIR=${payload}`, `-DGENERATED_DIR=${generated}`, `-DOUT_FILE=${installer}`,
  path.join(root, 'packaging/windows/installer.nsi'),
], { stdio: 'inherit' })
if (!existsSync(installer)) throw Error(`makensis did not write ${installer}`)
console.log(installer)

/**
 * The binaries are MSVC builds that import the dynamic C++ runtime, which a clean
 * Windows 10 does not have. Copy it from the Visual Studio redistributable folder
 * (the supported app-local source), found through VCToolsRedistDir or vswhere.
 * Elsewhere (a cross-build) there is nothing to copy and the step is skipped.
 */
function copyVcRuntime() {
  if (!native) { console.log('skipping the C++ runtime DLLs (not a Windows host)'); return }
  const redist = process.env.VCToolsRedistDir ?? redistFromVswhere()
  const dir = redist && vcRuntimeCandidates(readdirSync(path.join(redist, 'x64'))).map(name => path.join(redist, 'x64', name)).find(existsSync)
  if (!dir) throw Error('Could not find the Visual C++ runtime (VC\\Redist\\MSVC\\<version>\\x64\\Microsoft.VC14x.CRT). Install Visual Studio Build Tools, or pass --no-vc-runtime')
  const copied = VC_RUNTIME_DLLS.filter(name => existsSync(path.join(dir, name)))
  if (!copied.includes('vcruntime140.dll')) throw Error(`${dir} has no vcruntime140.dll`)
  // `bin\kybern.exe` looks for its DLLs beside itself first, so it gets its own copies.
  for (const name of copied) for (const target of [payload, path.join(payload, 'bin')]) cpSync(path.join(dir, name), path.join(target, name))
  console.log(`C++ runtime from ${dir}: ${copied.join(', ')}`)
}

function redistFromVswhere(): string | undefined {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!existsSync(vswhere)) return undefined
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
  if (!install) return undefined
  const base = path.join(install, 'VC/Redist/MSVC')
  if (!existsSync(base)) return undefined
  const versions = readdirSync(base).filter(name => /^\d+\./.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const newest = versions.at(-1)
  return newest && path.join(base, newest)
}
