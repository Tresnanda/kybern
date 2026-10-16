/**
 * Long-lived reference environment for the shell3 checks: scratch daemon, seeded fixtures,
 * the conversation proxy and a Vite server for apps/desktop, held until this process is stopped.
 *
 *   bun scripts/shell3-up.ts [--fresh] [--dev] &      # prints READY <json> when usable
 *   bun scripts/visual-pair.ts --down         # stops daemon and Vite afterwards
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { SCRATCH, connect, freePort, readState, seed, startDaemon, writeState } from '../visual/fixture.ts'
import { loadAreaFixtures } from '../visual/load.ts'

let state = await startDaemon(process.argv.includes('--fresh'))
if (!state.seeded) { await seed(state); state = readState()! }
if (!state.vitePid) {
  // rolldown would load the GPUIX .node file named by this variable instead of its own binding.
  const { NAPI_RS_NATIVE_LIBRARY_PATH: _native, ...env } = process.env
  const desktop = path.resolve(import.meta.dir, '../../desktop')
  const vitePort = await freePort()
  // The reference is a production build, like the Tauri shell ships. `vite dev` runs StrictMode's double
  // effects, which leave BeUI's message rail permanently empty (its rAF cleanup never resets the frame ref).
  const dev = process.argv.includes('--dev')
  if (!dev) { const built = Bun.spawnSync(['pnpm', 'exec', 'vite', 'build'], { cwd: desktop, env, stdout: 'ignore', stderr: 'pipe' }); if (built.exitCode) throw new Error(built.stderr.toString()) }
  const child = spawn('pnpm', ['exec', 'vite', ...(dev ? [] : ['preview']), '--port', String(vitePort), '--strictPort'], { cwd: desktop, stdio: 'ignore', detached: true, env })
  child.unref()
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${vitePort}/`)).ok) break } catch {} await Bun.sleep(200) }
  state = { ...state, vitePid: child.pid, vitePort }
  writeState(state)
}
const client = await connect(state)
for (const f of Object.values(await loadAreaFixtures())) await f.ids?.(client)
writeFileSync(path.join(SCRATCH, 'shell3-up.json'), JSON.stringify({ proxy: process.env.KYBERN_URL, port: state.port, vite: state.vitePort }))
console.log('READY', JSON.stringify({ port: state.port, vite: state.vitePort, proxy: process.env.KYBERN_URL }))
setInterval(() => {}, 1 << 30)
