import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceDir = resolve(desktopDir, "../..")
const tauriCli = join(
  desktopDir,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js"
)
const sidecarConfig = "src-tauri/tauri.sidecar.conf.json"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceDir,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}`
    )
  }
  return options.capture ? result.stdout.trim() : ""
}

function targetArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--target") {
      const target = args[index + 1]
      if (!target) {
        throw new Error("--target requires a Rust target triple")
      }
      return target
    }
    if (arg.startsWith("--target=")) {
      return arg.slice("--target=".length)
    }
  }
  return undefined
}

function stageDaemon(tauriCommand, tauriArgs, childEnv) {
  const cliTarget = targetArgument(tauriArgs)
  const configuredTarget = process.env.CARGO_BUILD_TARGET?.trim()
  const targetTriple =
    cliTarget ??
    configuredTarget ??
    run("rustc", ["--print", "host-tuple"], { capture: true })

  if (targetTriple === "universal-apple-darwin") {
    throw new Error(
      "Universal macOS sidecars are not supported; build separate aarch64 and x86_64 packages."
    )
  }

  const release =
    tauriCommand === "dev"
      ? tauriArgs.includes("--release")
      : !tauriArgs.includes("--debug")
  const profile = release ? "release" : "debug"
  const cargoArgs = ["build", "--package", "kybern-daemon"]
  if (release) {
    cargoArgs.push("--release")
  }
  if (cliTarget) {
    cargoArgs.push("--target", cliTarget)
  }

  console.log(
    `Building kybernd sidecar (${profile}, ${targetTriple}) before Tauri ${tauriCommand}…`
  )
  run("cargo", cargoArgs, { env: childEnv })

  const targetDir = childEnv.CARGO_TARGET_DIR
  const usesTargetSubdirectory = Boolean(cliTarget || configuredTarget)
  const extension = targetTriple.includes("windows") ? ".exe" : ""
  const source = join(
    targetDir,
    ...(usesTargetSubdirectory ? [targetTriple] : []),
    profile,
    `kybernd${extension}`
  )
  if (!existsSync(source)) {
    throw new Error(`cargo did not produce the daemon at ${source}`)
  }

  const binariesDir = join(desktopDir, "src-tauri", "binaries")
  const destination = join(binariesDir, `kybernd-${targetTriple}${extension}`)
  mkdirSync(binariesDir, { recursive: true })
  copyFileSync(source, destination)
  if (!targetTriple.includes("windows")) {
    chmodSync(destination, 0o755)
  }
  console.log(`Staged ${destination}`)
}

try {
  if (!existsSync(tauriCli)) {
    throw new Error(
      "Tauri CLI is not installed; run pnpm install --frozen-lockfile first."
    )
  }

  const tauriArgs = process.argv.slice(2)
  const tauriCommand = tauriArgs[0]
  const preparesSidecar = ["dev", "build", "bundle"].includes(tauriCommand)
  const configuredTargetDir = process.env.CARGO_TARGET_DIR
  const targetDir = configuredTargetDir
    ? isAbsolute(configuredTargetDir)
      ? configuredTargetDir
      : resolve(workspaceDir, configuredTargetDir)
    : join(workspaceDir, "target")
  const childEnv = { ...process.env, CARGO_TARGET_DIR: targetDir }

  if (preparesSidecar) {
    stageDaemon(tauriCommand, tauriArgs.slice(1), childEnv)
    tauriArgs.splice(1, 0, "--config", sidecarConfig)
  }

  const result = spawnSync(process.execPath, [tauriCli, ...tauriArgs], {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  })
  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
