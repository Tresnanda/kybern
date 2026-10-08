// Build the synthetic fixture separately; it never enters the shipped frontend.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const desktop = fileURLToPath(new URL("../", import.meta.url))
const fixture = process.argv[2] ?? "rendering"
if (!["accounts", "native-subagents", "visuals", "theme-provider", "real-session", "live-tool-memory", "usage", "tool-leases", "settings", "history-retention", "terminal-memory", "tool-memory", "image-memory", "app-update", "chat-collaboration", "collaboration", "markdown-memory", "worker-lifecycle", "profiles", "mermaid", "composer-stack", "scrolling", "work-shell", "work-stream", "history", "rendering", "materials", "scaling", "interaction", "questions", "artifacts", "memory", "continuation", "sessions", "chat-fixes", "activity", "prompts", "integrations", "icon-swap", "free-chat", "orchestrator", "pr-review"].includes(fixture)) throw new Error("Unknown rendering fixture")
const scratch = mkdtempSync(path.join(tmpdir(), "kybern-rendering-"))
let daemon
try {
  if (["tool-leases", "live-tool-memory"].includes(fixture)) {
    const repo = path.resolve(desktop, "../..")
    const binary = process.env.KYBERN_PERF_DAEMON_BINARY ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, "target"), "release/kybernd")
    const dataDir = path.join(scratch, "daemon")
    const initialize = spawnSync(binary, ["--data-dir", dataDir, "--print-token"], { stdio: "ignore" })
    if (initialize.error || initialize.status !== 0) throw new Error("Build the release daemon before the tool-leases fixture")
    const seedArgs = [path.join(desktop, fixture === "live-tool-memory" ? "scripts/seed-live-tools.py" : "scripts/seed-tool-leases.py"), dataDir]
    if (fixture === "live-tool-memory" && process.env.KYBERN_PERF_LIVE_HISTORY === "1") seedArgs.push("--history")
    const seed = spawnSync("python3", seedArgs, { encoding: "utf8" })
    if (seed.error || seed.status !== 0) throw new Error("Could not seed scratch lease data")
    daemon = spawn(binary, ["--data-dir", dataDir, "--port", "0"], { stdio: "ignore" })
    const until = Date.now() + 10000
    let port
    while (!port && Date.now() < until) {
      try { port = readFileSync(path.join(dataDir, "daemon.port"), "utf8").trim() } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    if (!port) throw new Error("Scratch lease daemon did not start")
    process.env.KYBERN_TOOL_LEASE_ENDPOINT = JSON.stringify({ url: `ws://127.0.0.1:${port}/ws`, http_base: `http://127.0.0.1:${port}`, token: readFileSync(path.join(dataDir, "daemon.token"), "utf8").trim(), environmentId: seed.stdout.trim() })
  }
  if (fixture === "real-session") {
    // Diagnostic: the shipped app over a snapshot of a real store (never the
    // live file) or over a fresh thread fed by the recorded-session replay.
    const repo = path.resolve(desktop, "../..")
    const binary = process.env.KYBERN_PERF_DAEMON_BINARY ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, "target"), "release/kybernd")
    const dataDir = path.join(scratch, "daemon")
    const replay = process.env.KYBERN_PERF_REPLAY_JSONL
    const store = process.env.KYBERN_PERF_SESSION_STORE
    if (!replay === !store) throw new Error("Set exactly one of KYBERN_PERF_SESSION_STORE or KYBERN_PERF_REPLAY_JSONL")
    const initialize = spawnSync(binary, ["--data-dir", dataDir, "--print-token"], { stdio: "ignore" })
    if (initialize.error || initialize.status !== 0) throw new Error("Build the release daemon before the real-session fixture")
    const seed = store
      ? spawnSync("sqlite3", [store, `.backup '${path.join(dataDir, "state.sqlite").replaceAll("'", "''")}'`], { encoding: "utf8" })
      : spawnSync("python3", [path.join(desktop, "scripts/seed-replay-session.py"), dataDir], { encoding: "utf8" })
    if (seed.error || seed.status !== 0) throw new Error(`Could not prepare the scratch store: ${seed.stderr}`)
    if (replay) process.env.KYBERN_SCROLL_SCENARIO = `replay:${process.env.KYBERN_PERF_REPLAY_PASSES ?? "3"}`
    else if (process.env.KYBERN_PERF_SESSION_THREADS) process.env.KYBERN_SCROLL_SCENARIO = `threads:${process.env.KYBERN_PERF_SESSION_THREADS}`
    daemon = spawn(binary, ["--data-dir", dataDir, "--port", "0"], { stdio: "ignore", env: { ...process.env, ...(replay ? { KYBERN_PERF_REPLAY_JSONL: path.resolve(replay) } : {}) } })
    const until = Date.now() + 10000
    let port
    while (!port && Date.now() < until) {
      try { port = readFileSync(path.join(dataDir, "daemon.port"), "utf8").trim() } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    if (!port) throw new Error("Scratch session daemon did not start")
    process.env.KYBERN_TOOL_LEASE_ENDPOINT = JSON.stringify({ url: `ws://127.0.0.1:${port}/ws`, http_base: `http://127.0.0.1:${port}`, token: readFileSync(path.join(dataDir, "daemon.token"), "utf8").trim() })
  }
  if (fixture === "visuals") {
    const repo = path.resolve(desktop, "../..")
    const binary = process.env.KYBERN_PERF_DAEMON_BINARY ?? path.join(repo, "target/debug/kybernd")
    const cli = process.env.KYBERN_PERF_CLI_BINARY ?? path.join(repo, "target/debug/kybern")
    const dataDir = path.join(scratch, "daemon")
    daemon = spawn(binary, ["--data-dir", dataDir, "--port", "0"], { stdio: "ignore" })
    const until = Date.now() + 10000
    let port
    while (!port && Date.now() < until) { try { port = readFileSync(path.join(dataDir,"daemon.port"),"utf8").trim() } catch { await new Promise(resolve=>setTimeout(resolve,50)) } }
    if (!port) throw new Error("Build kybern before running the visual fixture")
    const call = (method,params) => {
      const result = spawnSync(cli,["--data-dir",dataDir,"call",method,JSON.stringify(params)],{encoding:"utf8"})
      if (result.status !== 0) throw new Error(result.stderr)
      return JSON.parse(result.stdout)
    }
    const project = call("projects.add",{path:scratch,name:"Inline visual fixture"})
    const thread = call("threads.create",{project_id:project.id,provider:{kind:"codex",instance:"default"},title:"Visual fixture",use_worktree:false})
    // Seed a turn in scratch storage without starting an authenticated provider.
    const seed = spawnSync("python3",["-c",`import sqlite3,json,uuid,sys
c=sqlite3.connect(sys.argv[1]); thread=sys.argv[2]; turn=str(uuid.uuid4()); at="2026-10-07T00:00:00Z"
payload=json.dumps({"kind":"turn_started","message_id":str(uuid.uuid4()),"message":{"content":[{"type":"text","text":"Show a visual"}]}})
c.execute("INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES(?,?,?,'turn_started',?)",(thread,turn,at,payload))
c.commit()`,path.join(dataDir,"state.sqlite"),thread.id],{encoding:"utf8"})
    if (seed.status!==0) throw new Error(seed.stderr)
    const image = path.join(scratch,"embedded.svg")
    writeFileSync(image,'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#526fff"/></svg>')
    const html = `<html><head><style>@keyframes fixturePulse{from{transform:translateX(0)}to{transform:translateX(5px)}}.late-css{animation:fixturePulse 100ms infinite}svg{display:block;width:100%;height:100px}table{border-collapse:collapse;width:100%}td{padding:6px 0;border-bottom:1px solid var(--border)}button{margin-top:12px;color:var(--foreground);background:var(--card);border:1px solid var(--border);padding:8px 12px;border-radius:var(--radius)}</style></head><body><svg viewBox="0 0 300 100" aria-label="Comparison chart"><rect width="80" height="80" y="20" fill="var(--chart-1)"/><rect x="100" width="80" height="55" y="45" fill="var(--chart-2)"/><rect x="200" width="80" height="35" y="65" fill="var(--chart-3)"/></svg><table><tbody><tr><td>North</td><td>80</td></tr><tr><td>South</td><td>55</td></tr><tr><td>West</td><td>35</td></tr></tbody></table><img id="embedded" width="40" height="40" src="${image}"><button id="counter">Count: 0</button><script>
      let counter=0,interval=0,raf=0,visible=true,isolated=false;
      try{void parent.document.body}catch{isolated=true}
      setInterval(()=>interval++,20);function tick(){raf++;requestAnimationFrame(tick)}requestAnimationFrame(tick);
      addEventListener('kybern-visibility',e=>visible=e.detail.visible);
      function report(){parent.postMessage({fixture:'kybern-visual',counter,interval,raf,visible,isolated,image:document.getElementById('embedded').naturalWidth>0,table:document.querySelectorAll('tbody tr').length,bars:document.querySelectorAll('svg rect').length,runningAnimations:document.getAnimations().filter(animation=>animation.playState==='running').length,pausedAnimations:document.getAnimations().filter(animation=>animation.playState==='paused').length,background:getComputedStyle(document.documentElement).backgroundColor,foreground:getComputedStyle(document.documentElement).color,accent:getComputedStyle(document.querySelector('svg rect')).fill},'*')}
      document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent='Count: '+(++counter);report()};
      addEventListener('message',e=>{if(e.data?.fixture!=='kybern-visual-command')return;if(e.data.action==='click')document.getElementById('counter').click();else if(e.data.action==='spoof-link')parent.postMessage({kind:'kybern-visual-link',url:'https://example.test/spoof'},'*');else if(e.data.action==='animate'){const css=document.createElement('span');css.className='late-css';document.body.append(css);const moving=document.createElement('span');document.body.append(moving);moving.animate([{opacity:0.5},{opacity:1}],{duration:200,iterations:Infinity});const paused=document.createElement('span');document.body.append(paused);paused.animate([{opacity:0.5},{opacity:1}],{duration:200,iterations:Infinity}).pause();report()}else report()});
      console.log('table rows',document.querySelectorAll('tbody tr').length);addEventListener('load',report);
    </script></body></html>`
    const publish = title => call("threads.visuals.publish",{thread_id:thread.id,html,title,height:600}).visual
    // Published before the preview browser is linked in, so it carries no measured heights.
    const unmeasured = publish("Regional comparison")
    // Reuse the installed preview browser (never downloaded here) so the daemon measures the second page.
    const browser = path.join(homedir(),".kybern/cache/html-preview")
    let visual = unmeasured
    if (existsSync(browser)) {
      // Link only the browser builds: measuring writes its scratch profiles beside them, and those
      // must land in the scratch data dir, not the user's ~/.kybern cache.
      mkdirSync(path.join(dataDir,"cache/html-preview"),{recursive:true})
      for (const entry of readdirSync(browser)) if (!entry.startsWith("render-")) symlinkSync(path.join(browser,entry),path.join(dataDir,"cache/html-preview",entry))
      visual = publish("Regional comparison, measured")
    }
    // Layout that does not depend on font metrics, so the daemon's and WebKit's heights agree exactly.
    const fixedHtml = '<!doctype html><html><head><style>body{margin:0}.box{height:210px;background:var(--chart-1)}@media(max-width:600px){.box{height:340px}}@media(max-width:400px){.box{height:420px}}</style></head><body><div class="box"></div></body></html>'
    const fixed = call("threads.visuals.publish",{thread_id:thread.id,html:fixedHtml,title:"Fixed layout",height:600}).visual
    rmSync(image)
    process.env.KYBERN_VISUAL_FIXTURE = JSON.stringify({url:`ws://127.0.0.1:${port}/ws`,http_base:`http://127.0.0.1:${port}`,token:readFileSync(path.join(dataDir,"daemon.token"),"utf8").trim(),thread_id:thread.id,visual,unmeasured,fixed})
  }
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
  const build = spawnSync("pnpm", ["exec", "vite", "build", "--config", "perf/vite.config.ts", "--outDir", dist], { cwd: desktop, encoding: "utf8", env: {
    ...process.env,
    KYBERN_PERF_FIXTURE: fixture,
    VITE_LIVE_TOOLS_HISTORY: process.env.KYBERN_PERF_LIVE_HISTORY ?? "0",
    VITE_LIVE_TOOLS_THREAD: process.env.KYBERN_PERF_LIVE_THREAD ?? "0",
    VITE_LIVE_TOOLS_SHELL: process.env.KYBERN_PERF_LIVE_SHELL ?? "0",
    VITE_LIVE_TOOLS_EMPTY_SIDEBAR: process.env.KYBERN_PERF_LIVE_EMPTY_SIDEBAR ?? "0",
    VITE_LIVE_TOOLS_IMPORT_APP: process.env.KYBERN_PERF_LIVE_IMPORT_APP ?? "0",
    VITE_LIVE_TOOLS_STACKED_CONTENT_CARD: process.env.KYBERN_PERF_LIVE_STACKED_CONTENT_CARD ?? "0",
    VITE_LIVE_TOOLS_UNBOUND_TURN_DIFFS: process.env.KYBERN_PERF_LIVE_UNBOUND_TURN_DIFFS ?? "0",
    VITE_EARLIER_STATUS_UNHOSTED: process.env.KYBERN_PERF_EARLIER_STATUS_UNHOSTED ?? "0",
  } })
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
