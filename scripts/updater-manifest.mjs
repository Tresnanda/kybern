#!/usr/bin/env node
// Write dist/latest.json, the static manifest the Kybern GPUIX updater polls
// (the endpoint in apps/gpuix/src/platform/updater.json). A dev release
// (`X.Y.Z-dev.N`, or any version with a prerelease part) writes
// dist/latest-dev.json instead: the release is a GitHub prerelease, which
// `releases/latest` skips, and .github/workflows/dev-feed.yml copies the file to
// the rolling `dev-feed` release that Dev installs read (`devEndpoints`).
//
// Usage: node scripts/updater-manifest.mjs [--tag vX.Y.Z] [--repo owner/name]
//        [--notes-file path/to/release-notes.md] [--dist dir]
//
// scripts/bundle-gpuix.sh's kybern-gpuix_<version>_<arch>.app.tar.gz and its
// .sig (arch aarch64 or x86_64) become a `darwin-<arch>-gpuix` entry (the
// updater reads only its own platform's key). The Windows build is
// kybern-gpuix_<version>_x64-setup.exe (scripts/bundle-gpuix-windows.sh) plus its
// .sig, which become `windows-x86_64-gpuix`. scripts/bundle-gpuix-linux.sh's
// kybern-gpuix_<version>_x86_64.AppImage and its .sig become
// `linux-x86_64-gpuix`; the .deb and .rpm beside it are not feed entries (those
// installs only announce a release). An asset that is missing (its job failed)
// or unsigned is skipped; the other entries are still written. The plain
// `darwin-aarch64`-style keys of the retired Tauri app are no longer written.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = Object.fromEntries(
  process.argv.slice(2).map((arg, i, all) => {
    if (!arg.startsWith("--")) return []
    const eq = arg.indexOf("=")
    return eq === -1 ? [arg.slice(2), all[i + 1] ?? ""] : [arg.slice(2, eq), arg.slice(eq + 1)]
  }).filter((pair) => pair.length),
)
const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? "Tresnanda/kybern"
const version = readFileSync(join(root, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1]
if (!version) {
  console.error("no workspace version in Cargo.toml")
  process.exit(1)
}
const tag = args.tag || `v${version}`
const dist = args.dist ? resolve(args.dist) : join(root, "dist")
const notesFile = args["notes-file"]
const releaseNotes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : ""

const platforms = {}
const gpuixAssets = [
  ...["aarch64", "x86_64"].map((arch) => [`darwin-${arch}-gpuix`, `kybern-gpuix_${version}_${arch}.app.tar.gz`]),
  ["windows-x86_64-gpuix", `kybern-gpuix_${version}_x64-setup.exe`],
  ["linux-x86_64-gpuix", `kybern-gpuix_${version}_x86_64.AppImage`],
]
for (const [platform, gpuixAsset] of gpuixAssets) {
  if (existsSync(join(dist, gpuixAsset)) && existsSync(join(dist, `${gpuixAsset}.sig`))) {
    platforms[platform] = {
      signature: readFileSync(join(dist, `${gpuixAsset}.sig`), "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${gpuixAsset}`,
    }
  }
}

if (Object.keys(platforms).length === 0) {
  console.error(`no signed kybern-gpuix_${version}_* assets in ${dist}; run the scripts/bundle-gpuix*.sh scripts first`)
  process.exit(1)
}

// A prerelease must never be served as the stable feed, even by a release whose assets someone renamed.
const feed = /^\d+\.\d+\.\d+-/.test(version) ? "latest-dev.json" : "latest.json"
const manifest = {
  version,
  notes: releaseNotes || `Release notes: https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
}
writeFileSync(join(dist, feed), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote dist/${feed} for ${version}: ${Object.keys(platforms).join(", ")}`)
