/**
 * The real app plus one harness endpoint (WP1): scroll the transcript from inside the app process and report the
 * UI-thread bridge cost (`getBridgeStats`) of that window. `platform-smoke.ts --scroll` launches this instead of
 * `src/main.tsx`; the rendered product is unchanged.
 *
 * The endpoint listens on 127.0.0.1 (port written to `$KYBERN_DATA_DIR/bridge-probe.port`) and takes
 * `POST {"action":"scroll","target":"transcript","durationMs":2000}`: wheel steps every 16 ms over the target's centre,
 * up for the first half and back down for the second, with the bridge counters read before and after and the scroll
 * offset at the start, the turn and the end.
 * The wheel input is itself a waited bridge call off macOS; it is reported as `inputCalls` so callers can subtract it.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

type Stats = { bridged: boolean; sent: number; waited: number; waitMs: number; servedFrames: number | null; drawnFrames?: number | null; callbackFrames?: number | null; frameWakes: number }
type Renderer = {
  getAutomationTree(): string
  getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null
  getListScrollTop(id: number): number[] | null
  getScrollOffset(id: number): number[] | null
  simulateScrollWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string | null): void
  getBridgeStats?(): Stats
}

let root: { containerInfo?: { nativeRenderer?: Renderer } } | undefined
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(), inject() { return 1 },
  onCommitFiberRoot(_id: number, value: typeof root) { root = value }, onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}

type Node = { id: number; testId?: string; children?: Node[] }
function find(renderer: Renderer, testId: string): number | undefined {
  const tree = JSON.parse(renderer.getAutomationTree()) as Node | Node[] | null
  const stack = Array.isArray(tree) ? [...tree] : tree ? [tree] : []
  for (let visited = 0; stack.length && visited < 200_000; visited++) {
    const node = stack.pop()!
    if (node.testId === testId) return node.id
    stack.push(...(node.children ?? []))
  }
}

const server = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 60,
  async fetch(request) {
    const body = await request.json() as { action: string; target?: string; durationMs?: number; delta?: number }
    const renderer = root?.containerInfo?.nativeRenderer
    if (!renderer) return Response.json({ error: 'the app has not committed yet' }, { status: 503 })
    if (body.action !== 'scroll') return Response.json({ error: `unknown action ${body.action}` }, { status: 400 })
    const id = find(renderer, body.target ?? 'transcript')
    const bounds = id == null ? null : renderer.getElementBounds(id)
    if (id == null || !bounds) return Response.json({ error: `no painted ${body.target ?? 'transcript'}` }, { status: 404 })
    const offset = () => renderer.getListScrollTop(id) ?? renderer.getScrollOffset(id)
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
    const duration = body.durationMs ?? 2000, delta = body.delta ?? 60
    const offsets: (number[] | null)[] = [offset()]
    // Which addon methods the app calls during the window (any of them may be a waited UI-thread call off macOS).
    const calls: Record<string, number> = {}
    const proto = Object.getPrototypeOf(renderer) as Record<string, unknown>
    const wrapped: [string, unknown][] = []
    for (const name of Object.getOwnPropertyNames(proto)) {
      const original = proto[name]
      if (typeof original !== 'function' || name === 'constructor' || name === 'getBridgeStats') continue
      wrapped.push([name, original])
      proto[name] = function (this: unknown, ...args: unknown[]) { calls[name] = (calls[name] ?? 0) + 1; return (original as (...a: unknown[]) => unknown).apply(this, args) }
    }
    const before = renderer.getBridgeStats?.() ?? null
    const started = performance.now()
    // Every call this loop makes into the addon (wheel steps and the one offset read in the middle) waits off macOS.
    let inputCalls = 0, turned = false
    while (performance.now() - started < duration) {
      const elapsed = performance.now() - started
      if (!turned && elapsed >= duration / 2) { offsets.push(offset()); inputCalls++; turned = true }
      // Up (towards older turns) first: the transcript opens at its end.
      renderer.simulateScrollWheel(x, y, 0, elapsed < duration / 2 ? delta : -delta)
      inputCalls++
      await Bun.sleep(16)
    }
    const after = renderer.getBridgeStats?.() ?? null
    for (const [name, original] of wrapped) proto[name] = original
    offsets.push(offset())
    return Response.json({ seconds: (performance.now() - started) / 1000, inputCalls, before, after, offsets, calls })
  },
})
writeFileSync(path.join(process.env.KYBERN_DATA_DIR!, 'bridge-probe.port'), String(server.port))
await import('../src/main.tsx')
