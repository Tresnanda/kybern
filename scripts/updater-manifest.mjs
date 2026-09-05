#!/usr/bin/env node
// Merge the per-platform dist/updater-*.json fragments written by
// scripts/desktop-artifacts.mjs into dist/latest.json, the static manifest the
// desktop updater plugin polls (see plugins.updater.endpoints in tauri.conf.json).
//
// Usage: node scripts/updater-manifest.mjs [--tag vX.Y.Z] [--repo owner/name]
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
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
const dist = join(root, "dist")

const platforms = {}
for (const file of readdirSync(dist).filter((name) => /^updater-.*\.json$/.test(name)).sort()) {
  const fragment = JSON.parse(readFileSync(join(dist, file), "utf8"))
  platforms[fragment.platform] = { signature: fragment.signature, url: fragment.url }
}
if (Object.keys(platforms).length === 0) {
  console.error("no dist/updater-*.json fragments; run scripts/desktop-artifacts.mjs for each target first")
  process.exit(1)
}

const manifest = {
  version,
  notes: `Release notes: https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
}
writeFileSync(join(dist, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote dist/latest.json for ${version}: ${Object.keys(platforms).join(", ")}`)
