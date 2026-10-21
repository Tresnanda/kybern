// The memory fixture plus one action: the release a window gets when it goes
// to the background (`platform/idleMemory.ts`). Automation windows are never
// key, so the policy itself fires only once after launch; the harness calls
// the same function where a real window would lose focus.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
// Debug lines go to stderr: stdout carries the automation protocol.
const log = console.log
console.log = (...args: unknown[]) => { if (typeof args[0] === 'string' && /^\[(visibility|compact|idle-memory)\]/.test(args[0])) console.error(...args); else log(...args) }
await import('../memory/app.ts')
const { each, getObjc, nsApp, sel } = await import('../../src/native/objc.ts')
const renderer = () => ((globalThis as Record<string, unknown>).__gpuixRenderHost as { renderer: object }).renderer
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json() as { action: string }
  // Imported on use: a baseline run loads source from before the release existed.
  if (body.action === 'release') return Response.json((await import('../../src/platform/idleMemory.ts')).releaseIdleMemory(renderer()))
  if (body.action === 'minimize') { (renderer() as { minimizeWindow?: () => void }).minimizeWindow?.(); return Response.json({}) }
  // Back on the test display without activating the app (as loops8-lab.tsx).
  if (body.action === 'restore') {
    const o = getObjc(), app = nsApp()
    if (app) each(o, o.msg(app, sel(o, 'windows')) as never, window => { o.msgSetPtr(window, sel(o, 'deminiaturize:'), null as never); o.msg(window, sel(o, 'orderFrontRegardless')) })
    return Response.json({})
  }
  return Response.json({ error: `Unknown action ${body.action}` }, { status: 400 })
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'ramfix-control.json'), JSON.stringify({ port: server.port }))
process.stdin.on('end', () => server.stop(true))
