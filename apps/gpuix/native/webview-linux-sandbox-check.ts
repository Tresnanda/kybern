// WP10 Linux: where upstream WebKit would run pages without its sandbox (a Snap's `SNAP*` environment, which a Snap
// terminal passes to its children, or WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS), the web view is off and falls back to
// the browser, and no web process starts. Checks the JS probe (`webHost`) and the companion (`check_sandbox`) in
// children started with that environment, then the same run without it on this machine as the control. Then WebKit
// itself, without the companion (the spike `offscreen.c` linked against native/build/wpe): with a Snap environment it
// must abort before spawning a web process (wpe-sandbox.patch), and WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS must not
// take the sandbox away.
//   bun native/webview-linux-sandbox-check.ts        (needs native/build/libkybern-webview.so and native/build/wpe)
import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const LIB = path.join(import.meta.dir, 'build', 'libkybern-webview.so')

/** Web processes this process started (children of it or of the bwrap it ran), with their PID namespace depth. */
function webProcesses(root: number) {
  const parent = new Map<number, number>(), found: { pid: number; levels: number }[] = []
  for (const name of readdirSync('/proc')) {
    const pid = Number(name)
    if (!pid) continue
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      parent.set(pid, Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0))
      if (/^Name:\s+WPEWebProcess/m.test(status)) found.push({ pid, levels: (/^NSpid:\s+(.*)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/).length })
    } catch { /* exited */ }
  }
  const descends = (pid: number) => { for (let p = pid, n = 0; p && n < 64; p = parent.get(p) ?? 0, n++) if (p === root) return true; return false }
  return found.filter(p => descends(p.pid))
}

if (process.argv[2] === 'child') {
  const { webHost } = await import('../src/native/webview.ts')
  const lib = dlopen(LIB, {
    kybern_web_init: { args: [FFIType.ptr], returns: FFIType.void },
    kybern_web_next: { args: [], returns: FFIType.cstring },
    kybern_web_command: { args: [FFIType.ptr], returns: FFIType.void },
    kybern_web_unavailable_reason: { args: [], returns: FFIType.cstring },
  })
  const wake = new JSCallback(() => {}, { args: [], returns: FFIType.void, threadsafe: true })
  lib.symbols.kybern_web_init(wake.ptr)
  const reason = lib.symbols.kybern_web_unavailable_reason()
  const html = '<!doctype html><iframe src="http://127.0.0.1:9/"></iframe>'
  lib.symbols.kybern_web_command(ptr(Buffer.from(JSON.stringify({ op: 'create', id: 'probe', category: 'visual', generation: 1, allowedOrigins: [], html }) + '\0')))
  const events: unknown[] = []
  let processes: { pid: number; levels: number }[] = []
  for (const end = Date.now() + 8000; Date.now() < end;) {
    for (let raw = lib.symbols.kybern_web_next(); raw; raw = lib.symbols.kybern_web_next()) events.push(JSON.parse(String(raw)))
    processes = [...processes, ...webProcesses(process.pid).filter(p => !processes.some(q => q.pid === p.pid))]
    if (events.some((e: any) => e.type === 'failed' || e.type === 'loaded')) break
    await Bun.sleep(100)
  }
  console.log(JSON.stringify({ js: webHost.unavailableReason, companion: reason ? String(reason) : null, events, processes }))
  process.exit(0)
}

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
async function run(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^SNAP|^WEBKIT_DISABLE_SANDBOX/.test(key)))
  const child = Bun.spawn(['bun', import.meta.path, 'child'], { env: { ...clean, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const line = out.trim().split('\n').at(-1) ?? ''
  try { return { code, ...JSON.parse(line) } } catch { return { code, js: undefined, companion: undefined, events: [], processes: [], err: err.slice(-2000) } }
}

const refused: [string, Record<string, string>, RegExp][] = [
  ['a Snap environment (SNAP, SNAP_NAME, SNAP_REVISION)', { SNAP: '/snap/code/200', SNAP_NAME: 'code', SNAP_REVISION: '200' }, /Snap/],
  ['WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1', { WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' }, /WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS/],
]
for (const [name, env, reason] of refused) {
  const r = await run(env)
  check(`${name}: the JS probe falls back to the browser`, r.js === 'sandbox', JSON.stringify(r.js))
  check(`${name}: the companion refuses with its reason`, reason.test(r.companion ?? ''), JSON.stringify(r.companion ?? r.err))
  check(`${name}: creating a page fails`, r.events.some((e: any) => e.type === 'failed' && e.id === 'probe'), JSON.stringify(r.events))
  check(`${name}: no web process starts`, r.code === 0 && r.processes.length === 0, `exit ${r.code}, ${JSON.stringify(r.processes)}`)
}
// The control: without that environment the page loads and every web process is in its own PID namespace (bwrap).
const control = await run({})
if (control.js === null && control.companion === null) {
  check('control: the page loads', control.events.some((e: any) => e.type === 'loaded'), JSON.stringify(control.events))
  check('control: every web process runs in the sandbox', control.processes.length > 0 && control.processes.every((p: any) => p.levels > 1), JSON.stringify(control.processes))
} else console.log(`NOTE control: the web view is off on this machine (${control.companion ?? control.js}), so only the refusals ran`)
// WebKit's own backstop, with no companion in front of it.
const wpe = path.join(import.meta.dir, 'build', 'wpe')
if (existsSync(path.join(wpe, 'lib', 'pkgconfig'))) {
  const work = mkdtempSync(path.join(tmpdir(), 'kybern-wpe-backstop-')), binary = path.join(work, 'offscreen')
  try {
    const env = { ...process.env, PKG_CONFIG_PATH: path.join(wpe, 'lib', 'pkgconfig') }
    const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wpe-webkit-2.0', 'wpe-platform-2.0', 'wpe-platform-headless-2.0'], { env, encoding: 'utf8' }).trim().split(/\s+/)
      // WPE's .pc names libsoup, which the probe never calls: on 24.04 `-lsoup-3.0` finds the system's newer libsoup (the
      // bundle has only the soname), whose nghttp2 symbols the bundled nghttp2 lacks. The bundled one loads at run time.
      .filter(flag => flag !== '-lsoup-3.0')
    execFileSync('cc', ['-O1', '-o', binary, path.join(import.meta.dir, 'spikes/wp10/wpe-offscreen/offscreen.c'), `-Wl,-rpath,${path.join(wpe, 'lib')}`, ...flags], { env, stdio: 'inherit' })
    // Kybern's own bwrap where the system one is refused (Ubuntu 24.04 with the .deb's AppArmor profile).
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^SNAP|^WEBKIT_DISABLE_SANDBOX/.test(key)))
    const bundled = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], { stdio: 'ignore' }).status === 0 ? {} : { SPIKE_BUNDLED_BWRAP: '1' }
    const offscreen = (extra: Record<string, string>) => {
      const r = spawnSync(binary, [], { cwd: work, env: { ...clean, ...bundled, ...extra }, encoding: 'utf8', timeout: 60000 })
      return { code: r.status, signal: r.signal, log: `${r.stdout}\n${r.stderr}` }
    }
    const snap = offscreen({ SNAP: '/snap/code/200', SNAP_NAME: 'code', SNAP_REVISION: '200' })
    check('WebKit with a Snap environment aborts before any web process starts', snap.code !== 0 && /refusing to start a WebKit process without its sandbox/.test(snap.log) && !/^CHECK frame/m.test(snap.log),
      `exit ${snap.code ?? snap.signal}; ${snap.log.split('\n').filter(l => /CHECK|Kybern|rror/.test(l)).slice(0, 6).join(' | ')}`)
    const dangerous = offscreen({ WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' })
    check('WebKit ignores WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS (the web process stays sandboxed)', /^CHECK sandbox ok/m.test(dangerous.log),
      dangerous.log.split('\n').filter(l => /^CHECK/.test(l)).join(' | ') || dangerous.log.slice(-1500))
  } catch (error) {
    check('WebKit backstop run', false, String(error))
  } finally { rmSync(work, { recursive: true, force: true }) }
} else console.log('NOTE native/build/wpe has no pkg-config files: the WebKit backstop runs were skipped')

const failed = results.filter(r => !r.ok)
console.log(`${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
