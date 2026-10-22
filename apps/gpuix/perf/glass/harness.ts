// Launch plumbing for the glass checker: the hidden test display (started only when none is running, stopped with the
// run), a wait for other agents' native builds and checks, and the fixture app's control client.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const MARKER = '/tmp/kybern-gpuix-test-display'

/** The hidden 1440×900@2x display of `perf/test-display`. Returns a stop function; a no-op when another run owns it. */
export async function ensureTestDisplay(buildDir: string): Promise<() => void> {
  if (existsSync(MARKER)) return () => {}
  mkdirSync(buildDir, { recursive: true })
  const bin = path.join(buildDir, 'kybern-test-display')
  if (!existsSync(bin)) execFileSync('clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreGraphics', path.join(import.meta.dir, '../test-display/main.m'), '-o', bin])
  // Supervised like the scratch daemon (`seed.ts`): the display also goes when this process dies without its exit handlers.
  // It also removes the marker the display wrote, if it still names that display, however the display ended.
  const supervisor = `M=${MARKER}; "$0" & d=$!; id=''; while [ -z "$id" ] && kill -0 $d 2>/dev/null; do id=$(cat $M 2>/dev/null); sleep 0.1; done; `
    + `end() { kill $d 2>/dev/null; wait $d; [ -n "$id" ] && [ "$(cat $M 2>/dev/null)" = "$id" ] && rm -f $M; exit 0; }; trap end TERM INT HUP; `
    + `while kill -0 "$1" 2>/dev/null && kill -0 $d 2>/dev/null; do sleep 1; done; end`
  const child = spawn('/bin/sh', ['-c', supervisor, bin, String(process.pid)], { stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  while (!existsSync(MARKER)) {
    if (child.exitCode !== null || Date.now() > deadline) { child.kill(); throw Error('The hidden test display did not start') }
    await Bun.sleep(50)
  }
  // Let WindowServer finish the display reconfiguration before a window is placed on it.
  await Bun.sleep(1500)
  const id = readFileSync(MARKER, 'utf8').trim()
  return () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    // The display removes its marker on SIGTERM; if it could not (killed with its parent), remove ours, never another's.
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) Bun.sleepSync(50)
    try { if (readFileSync(MARKER, 'utf8').trim() === id) unlinkSync(MARKER) } catch {}
  }
}

/** Native builds or display checks by other agents (cargo, `native/update.sh`, `perf/backdrop`, native checks). */
export function busyProcesses(): string[] {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout
  const own = new Set([process.pid, process.ppid])
  return out.split('\n').map((l) => l.trim()).filter(Boolean).filter((line) => {
    const pid = Number(line.split(/\s+/, 1)[0])
    if (own.has(pid)) return false
    // Shell wrappers and greps of agent tool calls quote these names without running them.
    const command = line.slice(String(pid).length).trim()
    if (/^(\/bin\/)?(zsh|bash|sh) -c\b|^(\/usr\/bin\/)?(grep|pgrep|ps)\b/.test(command)) return false
    return /\bcargo\b|native\/update\.sh|check-update|perf\/backdrop\/|native\/check\.sh|native\/[\w-]+-check\.ts|perf\/bench\/(run|gate2?|popup)\.ts/.test(line)
  })
}
/** Poll every 30 s, up to `maxMs`, until no such process runs. Returns false when it is still busy. */
export async function waitForQuiet(maxMs = 20 * 60_000, log = (s: string) => console.log(s)): Promise<boolean> {
  const end = Date.now() + maxMs
  for (;;) {
    const busy = busyProcesses()
    if (!busy.length) return true
    if (Date.now() > end) return false
    log(`[glass] waiting for ${busy.length} native build/check process(es): ${busy[0]!.slice(0, 160)}`)
    await Bun.sleep(30_000)
  }
}

/** The fixture app's control server (`perf/glass/app.ts`). */
export async function controlFor(clientDir: string, timeoutMs = 30_000) {
  const file = path.join(clientDir, 'glass-control.json')
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) { if (Date.now() > deadline) throw Error('The glass control server did not start'); await Bun.sleep(100) }
  const { port } = JSON.parse(readFileSync(file, 'utf8')) as { port: number }
  return async <T = Record<string, unknown>>(action: string, args: object = {}): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
    const body = await res.json() as T & { error?: string }
    if (!res.ok) throw Error(`control ${action}: ${body.error ?? res.status}`)
    return body
  }
}
