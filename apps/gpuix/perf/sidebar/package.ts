/** Matched app/native resources; sidebar-owned sources form the control. */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const root = path.resolve(import.meta.dir, '../..')
for (const variant of ['baseline', 'candidate']) {
  const app = path.join(root, `dist/sidebar-${variant}.app`), contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources'), macos = path.join(contents, 'MacOS')
  mkdirSync(resources, { recursive: true }); mkdirSync(macos, { recursive: true })
  cpSync(path.join(root, 'packaging/Info.plist'), path.join(contents, 'Info.plist'))
  for (const name of ['kybernd', 'kybern']) cpSync(`/Applications/kybern.app/Contents/MacOS/${name}`, path.join(macos, name))
  for (const name of ['gpuix-native.darwin-arm64.node', 'kybern-webview.dylib']) {
    rmSync(path.join(resources, name), { force: true })
    cpSync(path.join(root, 'native/build', name), path.join(resources, name))
  }
  writeFileSync(path.join(resources, 'version'), '0.9.1')
  for (const name of ['fonts', 'providers']) cpSync(path.join(root, 'src/assets', name), path.join(resources, 'src/assets', name), { recursive: true })
  cpSync(path.join(root, '../../assets/release-background.png'), path.join(resources, 'release-background.png'))
  cpSync(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), path.join(resources, 'mermaid.min.js'))
  const result = await Bun.build({ entrypoints: [path.join(root, 'packaging/entry.ts')], target: 'bun', compile: { outfile: path.join(macos, 'Kybern GPUIX'), autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false }, external: ['@gpuix/native-*'], plugins: [{name:'sidebar-control', setup(build) {
    build.onLoad({filter:/\.[cm]?[jt]sx?$/}, args => {
      if (!args.path.startsWith(path.join(root, 'src/'))) return
      let source = readFileSync(args.path, 'utf8')
      if (variant === 'baseline' && ['src/Sidebar.tsx', 'src/sidebar/rows.tsx', 'src/sidebar/reorder.tsx'].some(file => args.path === path.join(root, file))) source = execFileSync('git', ['show', `564151aa:apps/gpuix/${path.relative(root, args.path)}`], { cwd: path.resolve(root, '../..'), encoding: 'utf8' })
      if (source.includes('import.meta.url')) source = source.replaceAll('import.meta.url', `new URL(${JSON.stringify(path.relative(root,args.path))}, 'file://' + process.env.KYBERN_GPUIX_RESOURCES + '/').href`)
      return { contents: source, loader: args.path.endsWith('tsx') ? 'tsx' : args.path.endsWith('ts') ? 'ts' : 'js' }
    })
  }}] })
  if (!result.success) throw new AggregateError(result.logs, 'Compile failed')
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' })
  console.log(app)
}
