// Build the synthetic fixture separately; it never enters the shipped frontend.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const desktop = fileURLToPath(new URL("../", import.meta.url))
const fixture = process.argv[2] ?? "rendering"
if (!["composer-stack", "scrolling", "work-shell", "work-stream", "history", "rendering", "materials", "scaling", "interaction", "questions", "artifacts", "memory", "continuation", "sessions", "chat-fixes", "activity", "prompts", "integrations"].includes(fixture)) throw new Error("Unknown rendering fixture")
const scratch = mkdtempSync(path.join(tmpdir(), "kybern-rendering-"))
let daemon
try {
  if (fixture === "integrations") {
    const repo = path.resolve(desktop, "../..")
    const dataDir = path.join(scratch, "daemon")
    daemon = spawn(path.join(repo, "target/debug/kybernd"), ["--data-dir", dataDir, "--port", "0"], { stdio: "ignore" })
    const until = Date.now() + 10000
    let port
    while (!port && Date.now() < until) {
      try { port = readFileSync(path.join(dataDir, "daemon.port"), "utf8").trim() } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    if (!port) throw new Error("Scratch preview daemon did not start; build kybern first")
    const call = (method, params) => {
      const result = spawnSync(path.join(repo, "target/debug/kybern"), ["--data-dir", dataDir, "call", method, JSON.stringify(params)], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
      return JSON.parse(result.stdout)
    }
    // This source is served by the actual daemon's sandboxed preview endpoint.
    writeFileSync(path.join(scratch, "demo.html"), `<html><body><h1>Interactive artifact</h1><button id="counter">Click</button><script>
      let count=0;let isolated=false;try{void parent.document.body}catch{isolated=true}
      document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent=String(++count);parent.postMessage({fixture:'kybern-artifact',count,isolated},'*')};
      addEventListener('message',e=>{if(e.data?.action==='click')document.getElementById('counter').click()});
      document.getElementById('counter').click();
    </script></body></html>`)
    const project = call("projects.add", { path: scratch, name: "Artifact rendering fixture" })
    const thread = call("threads.create", { project_id: project.id, provider: { kind: "claude-code", instance: "default" }, title: "Preview fixture", use_worktree: false })
    const urls = Array.from({ length: 2 }, () => `http://127.0.0.1:${port}/artifact-preview/${call("threads.artifacts.preview", { thread_id: thread.id, path: "demo.html" }).ticket}`)
    process.env.KYBERN_INTEGRATION_PREVIEW_URLS = JSON.stringify(urls)
  }
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
  daemon?.kill("SIGTERM")
  rmSync(scratch, { recursive: true, force: true })
}
