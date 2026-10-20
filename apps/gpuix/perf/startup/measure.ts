/** Capture-free startup timings. Visuals and resource runs are separate modes. */
import { connectStdio } from '@gpuix/react/automation'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { assertScratchEnv } from '../../src/requests/harness.ts'
const output = process.argv[2]!
if (!output) throw Error('Pass an output JSON path')
assertScratchEnv({ KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR, KYBERN_URL: '' })
const packaged = process.argv.includes('--packaged'), visuals = process.argv.includes('--visuals'), active = process.argv.includes('--active'), resources = process.argv.includes('--resources') || active, history = process.argv.includes('--history')
const data = process.env.KYBERN_DATA_DIR!, token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const rpcs: { id: unknown; method: string; start: number; end?: number; bytes?: number; before?: number }[] = []
const pending = new Map<unknown, (typeof rpcs)[number]>()
const proxy = Bun.serve<{ upstream: WebSocket }>({ port: 4325, hostname: '127.0.0.1', fetch(req, server) {
  const upstream = new WebSocket('ws://127.0.0.1:4324/ws', { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as never)
  if (server.upgrade(req, { data: { upstream } })) return
  upstream.close(); return new Response('WebSocket required', { status: 400 })
}, websocket: {
  open(socket) {
    socket.data.upstream.onmessage = e => {
      const message = JSON.parse(String(e.data)), entry = pending.get(message.id)
      const deliver = () => {
        if (entry) { entry.end = performance.now(); entry.bytes = String(e.data).length; pending.delete(message.id) }
        socket.send(String(e.data))
      }
      const delay = entry?.before == null ? 0 : Number(process.env.KYBERN_STARTUP_HISTORY_DELAY_MS ?? 0)
      if (delay) setTimeout(deliver, delay)
      else deliver()
    }
  },
  async message(socket, raw) {
    const message = JSON.parse(String(raw))
    if (message.id !== undefined) { const entry = { id: message.id, method: message.method, start: performance.now(), before: message.params?.before_seq }; rpcs.push(entry); pending.set(message.id, entry) }
    while (socket.data.upstream.readyState === WebSocket.CONNECTING) await Bun.sleep(1)
    socket.data.upstream.send(String(raw))
  }, close(socket) { socket.data.upstream.close() },
} })
const buildMarkers = () => {
  // Equivalent to ls /tmp/kybern-gpuix-native-build.*; filenames only, no credentials.
  return readdirSync('/tmp').filter(name => name.startsWith('kybern-gpuix-native-build.'))
}
const results: unknown[] = []
let discarded = 0
try {
  for (let iteration = 0; iteration < Number(process.env.KYBERN_STARTUP_RUNS ?? (visuals || resources ? 1 : 3)); iteration++) {
    while (buildMarkers().length) await Bun.sleep(1000)
    const markersBefore = buildMarkers(), markersDuring = new Set<string>()
    const watchBuilds = setInterval(() => { for (const marker of buildMarkers()) markersDuring.add(marker) }, 50)
    const prefsPath = path.join(data, 'gpuix-ui.json'), prefs = JSON.parse(readFileSync(prefsPath, 'utf8'))
    prefs['kybern.split-view.v1'] = { version: 1, root: { kind: 'leaf', id: 'main', threadId: process.env.KYBERN_STARTUP_THREAD! }, focusedPaneId: 'main' }
    writeFileSync(prefsPath, JSON.stringify(prefs))
    const start = performance.now(), wall = Date.now(), firstRpc = rpcs.length
    const command = packaged ? process.env.KYBERN_STARTUP_EXECUTABLE ?? path.resolve('dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX') : 'bun'
    const child = spawn(command, packaged ? [] : [process.env.KYBERN_STARTUP_ENTRY ?? 'src/main.tsx'], { env: { ...process.env, KYBERN_URL: 'ws://127.0.0.1:4325/ws', KYBERN_TOKEN: token, GPUIX_BACKGROUND: '1', KYBERN_STARTUP_TRACE: '1', KYBERN_OPAQUE: '1', KYBERN_FULL_RATE: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let diagnostics = '', remainder = ''
    const timeline: { phase: string; at: number; ms: number }[] = [], frames: number[] = [], frameTimestamps: number[] = []
    const costs: { render: number; layout: number }[] = []
    child.stderr.on('data', chunk => {
      diagnostics += String(chunk)
      const lines = (remainder + String(chunk)).split('\n'); remainder = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('[kybern-startup] ')) { const mark = JSON.parse(line.slice(17)); timeline.push({ ...mark, ms: mark.at - wall }) }
        const frame = line.match(/\[kybern-frame\] ([\d.]+)/); if (frame) { const at = Number(frame[1]), previous = frameTimestamps.at(-1); frameTimestamps.push(at); if (previous != null) frames.push(at - previous) }
        const cost = line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)/); if (cost) costs.push({ render: Number(cost[1]), layout: Number(cost[2]) })
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let app: Awaited<ReturnType<typeof connectStdio>> | undefined
    try {
      app = await Promise.race([
        connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => { child.stdout.on('data', chunk => listener(String(chunk))) }, close: async () => { child.kill() } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Startup timeout: ${diagnostics.slice(-2000)}`)), 45000); child.once('exit', code => reject(Error(`Exited ${code}: ${diagnostics.slice(-2000)}`))) }),
      ])
      clearTimeout(timer)
      const handshake = performance.now() - start
      let shell: number | undefined, sidebar: number | undefined, content: number | undefined
      let painted = ''
      while ((!content || !sidebar) && performance.now() - start < 45000) {
        painted = (await app.call('getPaintedText', {})).text.join('\n')
        if (painted.includes('Uncaught runtime errors:')) throw Error(painted)
        const now = performance.now() - start
        if (!shell && painted.includes('New chat')) shell = now
        if (!sidebar && painted.includes('Startup project')) sidebar = now
        if (!content && painted.includes('Startup result 2500')) content = now
        if (!content || !sidebar) await Bun.sleep(10)
      }
      if (!content) throw Error(`Newest message never painted: ${painted.slice(-1000)}\n${diagnostics.slice(-3000)}`)
      // Native CPU paint visibility is observed; this is not a physical presentation fence.
      const footprint = execFileSync('footprint', ['-p', String(child.pid)], { encoding: 'utf8' }).match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)?.slice(1)
      let openMs: number | undefined, openFootprint: string[] | undefined
      if (process.argv.includes('--open-thread')) {
        // Sidebar rows may have committed before their native bounds settle.
        await Bun.sleep(100)
        const openBounds = await app.getByTestId(`thread-${process.env.KYBERN_STARTUP_OTHER_THREAD!}`).bounds()
        const opened = performance.now()
        await app.getByTestId(`thread-${process.env.KYBERN_STARTUP_OTHER_THREAD!}`).click()
        while (performance.now() - opened < 30000) {
          if ((await app.call('getPaintedText', {})).text.some(text => text.includes('Startup result 2000'))) { openMs = performance.now() - opened; break }
          await Bun.sleep(10)
        }
        if (openMs == null) throw Error(`The selected long thread never painted: ${JSON.stringify({ openBounds, other: process.env.KYBERN_STARTUP_OTHER_THREAD, painted: (await app.call('getPaintedText', {})).text, rpcs: rpcs.slice(firstRpc).filter(rpc => rpc.method === 'threads.get') })}`)
        openFootprint = execFileSync('footprint', ['-p', String(child.pid)], { encoding: 'utf8' }).match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)?.slice(1)
      }
      if (visuals) { await Bun.sleep(Number(process.env.KYBERN_STARTUP_VISUAL_SETTLE_MS ?? 1500)); await app.screenshot({ path: output.replace(/\.json$/, '.png') }) }
      let resourceText: string | undefined, idleFrames: number | undefined, resourceFrames: number[] | undefined, resourceCosts: typeof costs | undefined
      let input: { packets: number; elapsed: number; maxOutstanding: number; acknowledgements: number[]; targetHz: number } | undefined
      if (resources) {
        let scrolling = active
        let producer: Promise<void> | undefined
        if (active) {
          const bounds = await app.getByTestId('transcript-surface').bounds(), point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
          const target = app, pending = new Set<Promise<unknown>>(), sent = performance.now()
          input = { packets: 0, elapsed: 0, maxOutstanding: 0, acknowledgements: [], targetHz: Number(process.env.KYBERN_STARTUP_INPUT_HZ ?? 60) }
          const metrics = input
          producer = (async () => {
            while (scrolling) {
              if (pending.size >= 32) await Promise.race(pending)
              const due = sent + metrics.packets * 1000 / metrics.targetHz
              if (performance.now() < due) await Bun.sleep(due - performance.now())
              if (!scrolling) break
              // Index-based trace: identical deltas/phase at the same offered
              // frequency in both versions, independent of ACK throughput.
              const now = performance.now(), cycle = (metrics.packets / metrics.targetHz) % 2, contact = cycle % 1
              const delta = (cycle < 1 ? 1 : -1) * 16 * (120 / metrics.targetHz) * (contact < 0.4 ? 1 : Math.exp(-(contact - 0.4) * 8))
              const request = target.call('scrollWheel', { ...point, deltaX: 0, deltaY: delta, phase: contact < 0.02 ? 'started' : 'moved' }).then(() => { metrics.acknowledgements.push(performance.now() - now); pending.delete(request) })
              pending.add(request); metrics.packets++; metrics.maxOutstanding = Math.max(metrics.maxOutstanding, pending.size)
            }
            await Promise.all(pending)
            metrics.elapsed = performance.now() - sent
            await target.call('scrollWheel', { ...point, deltaX: 0, deltaY: 0, phase: 'ended' })
          })()
        }
        await Bun.sleep(10000)
        const frameCount = frames.length, costCount = costs.length
        const inputAtSample = input?.packets
        const sample = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${child.pid}`], { stdout: 'pipe', stderr: 'pipe' })
        resourceText = await new Response(sample.stdout).text()
        if (await sample.exited !== 0) throw Error(await new Response(sample.stderr).text())
        resourceFrames = frames.slice(frameCount); resourceCosts = costs.slice(costCount)
        if (!active) idleFrames = frames.length - frameCount
        scrolling = false; await producer
        if (input && inputAtSample != null) Object.assign(input, { samplePackets: input.packets - inputAtSample })
      }
      let historyMs: number | undefined, historyFootprint: string[] | undefined, historyApplyMs: number | undefined, historyFrames: number[] | undefined
      if (history) {
        await Bun.sleep(2000)
        const bounds = await app.getByTestId('transcript-surface').bounds(), point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
        const historyStart = performance.now()
        const firstHistoryFrame = frames.length
        for (let i = 0; i < 160; i++) {
          // Positive wheel deltas move toward older messages in GPUI.
          await app.call('scrollWheel', { ...point, deltaX: 0, deltaY: 600, phase: i === 0 ? 'started' : 'moved' })
          await Bun.sleep(8)
          if (i % 8 === 0 && (await app.call('getPaintedText', {})).text.some(text => /Startup result 24[0-6]\d/.test(text))) { historyMs = performance.now() - historyStart; break }
        }
        await app.call('scrollWheel', { ...point, deltaX: 0, deltaY: 0, phase: 'ended' })
        if (historyMs === undefined) throw Error('Earlier content never painted')
        const begin = timeline.find(mark => mark.phase === 'history-start'), end = timeline.find(mark => mark.phase === 'history-ready')
        historyApplyMs = begin && end ? end.ms - begin.ms : undefined
        historyFrames = frames.slice(firstHistoryFrame)
        historyFootprint = execFileSync('footprint', ['-p', String(child.pid)], { encoding: 'utf8' }).match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)?.slice(1)
      }
      const result = { frameEncoding: 'intervals-ms', frameTimestamps, iteration, packaged, fullRate: 1, historyDelayMs: Number(process.env.KYBERN_STARTUP_HISTORY_DELAY_MS ?? 0), appearance: process.env.KYBERN_APPEARANCE ?? 'dark', handshake, shell, sidebar, content, footprint, openMs, openFootprint, historyMs, historyFootprint, historyApplyMs, historyFrames, timeline, rpcs: rpcs.slice(firstRpc).map(rpc => ({ method: rpc.method, ms: rpc.end == null ? null : rpc.end - rpc.start, fromSpawnMs: rpc.start - start, bytes: rpc.bytes, before: rpc.before })), frames, costs, idleFrames, resourceFrames, resourceCosts, input, resourceText }
      const markersAfter = buildMarkers()
      if (markersBefore.length || markersDuring.size || markersAfter.length) {
        writeFileSync(output.replace(/\.json$/, `-discarded-${discarded++}.json`), JSON.stringify({ reason: 'native build overlapped measurement', markersBefore, markersDuring: [...markersDuring], markersAfter, result }, null, 2))
        console.error('Discarding run because a native build overlapped it'); iteration--
      } else {
        results.push({ ...result, buildGuard: { markersBefore, markersDuring: [...markersDuring], markersAfter } }); console.log(JSON.stringify(result))
      }
      writeFileSync(output.replace(/\.json$/, `-${iteration}.log`), diagnostics)
    } finally {
      writeFileSync(output.replace(/\.json$/, `-${iteration}.log`), diagnostics)
      clearInterval(watchBuilds)
      clearTimeout(timer); await app?.close().catch(() => {}); child.kill()
      if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000).unref() })
    }
  }
  writeFileSync(output, JSON.stringify(results, null, 2))
} finally { proxy.stop(true) }
