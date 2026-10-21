#!/usr/bin/env node
// Extract kybernd and kybern from dist's archive for one target, so the app
// bundles ship the binaries dist built (release.yml's build-local-artifacts,
// attached to every release as kybern-<target>.tar.xz or .zip) instead of
// compiling the daemon and CLI again. Checks the archive against its .sha256
// and prints each binary's SHA-256.
//
// Usage: node scripts/dist-binaries.mjs --target <dist target> --from <dir> --out <dir>
//   --from  a folder holding kybern-<target>.tar.xz (or .zip) and its .sha256
//   --out   receives kybernd and kybern (.exe on Windows)
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { basename, join, resolve } from "node:path"

const args = parseArgs(process.argv.slice(2))
const target = args.target || fail("--target <dist target> is required")
const from = resolve(args.from || fail("--from <dir> is required"))
const out = resolve(args.out || fail("--out <dir> is required"))
const windows = target.includes("windows")
const archive = join(from, `kybern-${target}.${windows ? "zip" : "tar.xz"}`)
if (!existsSync(archive)) fail(`no dist archive at ${archive}`)

const checksumFile = `${archive}.sha256`
if (!existsSync(checksumFile)) fail(`no checksum at ${checksumFile}`)
const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0].toLowerCase()
const actual = sha256(archive)
if (actual !== expected) fail(`${basename(archive)} is ${actual}, but its .sha256 says ${expected}`)

mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(join(out, ".extract-"))
try {
  if (windows) {
    run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${scratch}'`])
  } else {
    run("tar", ["-xJf", archive, "-C", scratch])
  }
  // dist's tarballs hold a kybern-<target>/ folder; its zips are flat.
  const roots = [join(scratch, `kybern-${target}`), scratch]
  for (const name of ["kybernd", "kybern"].map((name) => `${name}${windows ? ".exe" : ""}`)) {
    const source = roots.map((root) => join(root, name)).find(existsSync) ?? fail(`${basename(archive)} has no ${name}`)
    const destination = join(out, name)
    copyFileSync(source, destination)
    if (!windows) chmodSync(destination, 0o755)
    console.log(`${sha256(destination)}  ${name} (from ${basename(archive)})`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`)
    const eq = arg.indexOf("=")
    if (eq !== -1) parsed[arg.slice(2, eq)] = arg.slice(eq + 1)
    else parsed[arg.slice(2)] = argv[++i] ?? ""
  }
  return parsed
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
