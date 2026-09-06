// Build the synthetic fixture separately; it never enters the shipped frontend.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const desktop = fileURLToPath(new URL("../", import.meta.url))
const fixture = process.argv[2] ?? "rendering"
if (!["rendering", "materials", "scaling", "interaction", "questions", "artifacts"].includes(fixture)) throw new Error("Unknown rendering fixture")
const scratch = mkdtempSync(path.join(tmpdir(), "kybern-rendering-"))
try {
  const dist = path.join(scratch, "dist")
  const build = spawnSync("pnpm", ["exec", "vite", "build", "--config", "perf/vite.config.ts", "--outDir", dist], { cwd: desktop, encoding: "utf8", env: { ...process.env, KYBERN_PERF_FIXTURE: fixture } })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(build.stdout + build.stderr)
  const config = JSON.parse(readFileSync(path.join(desktop, "src-tauri/tauri.conf.json"), "utf8"))
  const csp = path.join(scratch, "csp.txt")
  writeFileSync(csp, config.app.security.csp)
  const result = spawnSync("swift", [path.join(desktop, "scripts/check-rendering.swift"), dist, csp, fixture, ...(process.env.KYBERN_PERF_SCREENSHOT ? [process.env.KYBERN_PERF_SCREENSHOT] : [])], { stdio: "inherit" })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
