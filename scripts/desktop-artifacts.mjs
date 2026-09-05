#!/usr/bin/env node
// Collect the desktop bundles Tauri wrote for one target into dist/ under their
// release-asset names, and write the updater manifest fragment for that target
// (dist/updater-<os>-<arch>.json). scripts/updater-manifest.mjs merges the
// fragments from every platform into latest.json.
//
// Usage: node scripts/desktop-artifacts.mjs --target <rust triple> [--tag vX.Y.Z] [--repo owner/name]
//
// macOS: run scripts/bundle-macos.sh first; it writes the signed .app.tar.gz.
// Linux and Windows: run `pnpm tauri build --config src-tauri/tauri.updater.conf.json`
// with TAURI_SIGNING_PRIVATE_KEY set so the bundler emits the .sig files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = parseArgs(process.argv.slice(2))
const target = args.target ?? fail("--target <rust triple> is required")
const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? "Tresnanda/kybern"
const tag = args.tag || "untagged"
const version = readFileSync(join(root, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1] ?? fail("no workspace version in Cargo.toml")
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, "target")
const bundleDir = join(targetDir, "release", "bundle")
const dist = join(root, "dist")
mkdirSync(dist, { recursive: true })

const [arch, , os] = target.split("-") // aarch64-apple-darwin, x86_64-unknown-linux-gnu, x86_64-pc-windows-msvc
const platform = `${os}-${arch}`
const stem = `kybern-${version}-${target}`

let updaterFile
if (os === "darwin") {
  updaterFile = join(dist, `${stem}.app.tar.gz`)
} else if (os === "linux") {
  updaterFile = stage(find(join(bundleDir, "appimage"), /\.AppImage$/), `${stem}.AppImage`)
  stage(find(join(bundleDir, "deb"), /\.deb$/), `${stem}.deb`)
} else if (os === "windows") {
  updaterFile = stage(find(join(bundleDir, "nsis"), /-setup\.exe$/), `${stem}-setup.exe`)
} else {
  fail(`unsupported target ${target}`)
}

if (!existsSync(updaterFile)) fail(`missing updater artifact ${updaterFile}`)
const signature = `${updaterFile}.sig`
if (!existsSync(signature)) fail(`missing ${signature}; set TAURI_SIGNING_PRIVATE_KEY before building`)
const fragment = {
  platform,
  url: `https://github.com/${repo}/releases/download/${tag}/${basename(updaterFile)}`,
  signature: readFileSync(signature, "utf8").trim(),
}
writeFileSync(join(dist, `updater-${platform}.json`), `${JSON.stringify(fragment, null, 2)}\n`)
console.log(`wrote dist/updater-${platform}.json for ${basename(updaterFile)}`)

function stage(source, name) {
  const destination = join(dist, name)
  copyFileSync(source, destination)
  if (existsSync(`${source}.sig`)) copyFileSync(`${source}.sig`, `${destination}.sig`)
  console.log(`staged ${name}`)
  return destination
}

function find(dir, pattern) {
  const hit = existsSync(dir) ? readdirSync(dir).find((file) => pattern.test(file)) : undefined
  if (!hit) fail(`no file matching ${pattern} under ${dir}`)
  return join(dir, hit)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`)
    const eq = arg.indexOf("=")
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else out[arg.slice(2)] = argv[++i] ?? ""
  }
  return out
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
