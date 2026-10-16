/** Local macOS arm64 app; ad-hoc signing only, no installation. */
import { cpSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const root = path.resolve(import.meta.dir, '..')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Packaging requires macOS arm64')
const app = path.join(root, 'dist/Kybern GPUIX.app')
const resources = path.join(app, 'Contents/Resources')
const macos = path.join(app, 'Contents/MacOS')
const addon = path.join(root, 'native/build/gpuix-native.darwin-arm64.node')
if (!existsSync(addon)) throw Error('Build the patched native addon first (native/README.md)')
const binaries = ['kybern', 'kybernd'].map(name => ({ name, source: path.resolve(root, '../../target/debug', name) }))
for (const { source } of binaries) if (!existsSync(source)) throw Error(`Build this checkout's daemon and CLI before packaging: ${source}`)
const version = /\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(root, '../../Cargo.toml'), 'utf8'))?.[1]
if (!version) throw Error('Missing workspace release version')
mkdirSync(resources, {recursive:true}); mkdirSync(macos, {recursive:true})
for (const { name, source } of binaries) cpSync(source, path.join(macos, name))
writeFileSync(path.join(resources, 'version'), version)
cpSync(path.join(root, 'packaging/Info.plist'), path.join(app, 'Contents/Info.plist'))
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, path.join(app, 'Contents/Info.plist')])
cpSync(path.join(root, '../desktop/src-tauri/icons/icon.icns'), path.join(resources, 'icon.icns'))
cpSync(addon, path.join(resources, path.basename(addon)))
cpSync(path.join(root, 'src/assets/fonts'), path.join(resources, 'src/assets/fonts'), {recursive:true})
const previousCwd = process.cwd()
const buildTemps = new Set(readdirSync(root).filter(name => name.endsWith('.bun-build')))
process.chdir(root)
let result: Awaited<ReturnType<typeof Bun.build>>
try {
result = await Bun.build({
  entrypoints: [path.join(root, 'packaging/entry.ts')], target: 'bun',
  compile: {outfile:path.join(macos, 'Kybern GPUIX'), autoloadDotenv:false, autoloadBunfig:false, autoloadTsconfig:false, autoloadPackageJson:false},
  external: ['@gpuix/native-*'],
  plugins: [{name:'bundle-resource-urls', setup(build) {
    build.onLoad({filter:/\.[cm]?[jt]sx?$/}, async args => {
      if (!args.path.startsWith(path.join(root, 'src/'))) return
      let contents = readFileSync(args.path, 'utf8')
      if (args.path === path.join(root, 'src/main.tsx')) contents = contents.replace("appName: 'Kybern'", "appName: 'Kybern GPUIX'")
      // Keep source-relative resource lookup valid outside Bun's virtual filesystem.
      if (contents.includes('import.meta.url')) contents = contents.replaceAll('import.meta.url', `new URL(${JSON.stringify(path.relative(root,args.path))}, 'file://' + process.env.KYBERN_GPUIX_RESOURCES + '/').href`)
      return {contents, loader:args.path.endsWith('tsx') ? 'tsx' : args.path.endsWith('ts') ? 'ts' : 'js'}
    })
  }}],
})
} finally {
process.chdir(previousCwd)
for (const name of readdirSync(root)) if (name.endsWith('.bun-build') && !buildTemps.has(name)) rmSync(path.join(root, name))
}
if (!result.success) throw new AggregateError(result.logs, 'App compilation failed')
execFileSync('clang', ['-dynamiclib','-fobjc-arc','-fblocks','-framework','Cocoa','-framework','UserNotifications',path.join(root,'packaging/notifications.m'),'-o',path.join(resources,'notifications.dylib')], {stdio:'inherit'})
for (const file of ['gpuix-native.darwin-arm64.node', 'notifications.dylib']) execFileSync('codesign',['--force','--sign','-',path.join(resources,file)],{stdio:'inherit'})
for (const { name } of binaries) execFileSync('codesign',['--force','--sign','-',path.join(macos,name)],{stdio:'inherit'})
execFileSync('codesign',['--force','--sign','-',app],{stdio:'inherit'})
execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'})
console.log(app)
