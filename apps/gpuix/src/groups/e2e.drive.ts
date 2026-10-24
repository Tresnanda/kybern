// Drives `e2e.fixture.tsx` (the real app against a real scratch daemon) step by step over HTTP, for walking flows that
// need real agent turns and judgment between steps (the v0.15 group-project end-to-end pass):
//
//   E2E_SCRATCH=<…gpuix-scratch…> KYBERN_VERIFY_OUTPUT=<dir> bun src/groups/e2e.drive.ts [light|dark]
//   curl -s -X POST localhost:47811 -d '{"op":"click","id":"add-project"}'
//
// The scratch folder holds the daemon's data dir (`data/`, started separately) and `next-pick.txt`, the folder the next
// native folder panel returns. Ops: click/hover/fill/press/wait/count/text/bounds (by `id`, `text` or `type`), `nth`
// (`{id, n, click}`), shot (`{name}` → <output>/<name>.png), mouse, wheel, clock (`{action, ms}`), ids (`{match}`),
// painted, tree, diag, close. Reduce Motion follows `KYBERN_REDUCED_MOTION` (the dock's width tween needs real frames).
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const root = process.env.E2E_SCRATCH ?? ''
if (!root.includes('gpuix-scratch')) throw Error('E2E_SCRATCH must contain gpuix-scratch')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(root, 'shots')
const f = await launchFixture(path.join(import.meta.dir, 'e2e.fixture.tsx'), {
  E2E_SCRATCH: root, KYBERN_DATA_DIR: path.join(root, 'data'), KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_APPEARANCE: process.argv[2] === 'dark' ? 'dark' : 'light',
  KYBERN_GROUPS: process.env.KYBERN_GROUPS ?? '1', GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_GPUIX_ENVIRONMENT: 'local',
  KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(root, 'creds'),
  KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '1', KYBERN_WINDOW_SIZE: '1280x820',
})
const app = f.app
type Body = Record<string, any>
const locate = (b: Body) => (b.id ? app.getByTestId(b.id) : b.text ? app.getByText(b.text) : app.getByType(b.type))
async function handle(b: Body): Promise<unknown> {
  switch (b.op) {
    case 'click': await locate(b).click(b.button ? { button: b.button } : undefined); return 'ok'
    case 'hover': await locate(b).hover(); return 'ok'
    case 'fill': await locate(b).fill(b.value); return 'ok'
    case 'press': await locate(b).press(b.key); return 'ok'
    case 'wait': await locate(b).waitFor({ timeoutMs: b.ms ?? 20000 }); return 'ok'
    case 'count': return await locate(b).count()
    case 'text': return await locate(b).textContent()
    case 'bounds': return await locate(b).bounds()
    case 'nth': {
      const nodes = await app.getByTestId(b.id).all()
      const node = nodes.at(b.n ?? -1)
      if (b.click && node?.bounds) await app.mouse.click({ x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 })
      return { count: nodes.length, bounds: node?.bounds }
    }
    case 'shot': { const file = path.join(out, `${b.name}.png`); await app.screenshot({ path: file }); return file }
    case 'mouse': await (app.mouse as Record<string, any>)[b.action]({ x: b.x, y: b.y }, b.button ? { button: b.button } : undefined); return 'ok'
    case 'wheel': await locate(b).wheel(b.dx ?? 0, b.dy ?? 0); return 'ok'
    case 'clock': return await (app.clock as Record<string, (ms?: number) => Promise<number>>)[b.action]!(b.ms)
    case 'ids': return (await app.getByType(b.type ?? 'div').all()).map((n) => n.testId).filter((id) => id && (!b.match || id.includes(b.match)))
    case 'painted': return await app.call('getPaintedText' as never, {} as never)
    case 'tree': return JSON.stringify(await app.call('getTree' as never, {} as never)).slice(0, b.n ?? 20000)
    case 'diag': return f.diagnostics().slice(-(b.n ?? 4000))
    case 'close': setTimeout(async () => { await f.close(); process.exit(0) }, 50); return 'bye'
  }
  throw Error(`Unknown op ${b.op}`)
}
Bun.serve({
  port: Number(process.env.DRIVE_PORT ?? 47811),
  idleTimeout: 120,
  async fetch(request) {
    const body = (await request.json()) as Body
    try { return Response.json({ ok: true, r: await handle(body) }) } catch (error) { return Response.json({ ok: false, e: String(error) }) }
  },
})
console.log('driver ready')
