/**
 * Headless bench for #248: lists and thread opens exactly as GPUIX issues them, timed from the "click" (the call
 * that starts an open) to the first drawable content, with round trips and bytes. Scratch daemons only.
 *
 *   bun perf/instant-load-2026-11/bench.ts --daemon <kybernd> --flow current|instant --label <name>
 *       [--runs 8] [--warm 5] [--rtt 0] [--mbps 0] [--linger 1] [--out <file.json>]
 *
 * `--linger 0` (instant flow) closes sessions at once, so reopens measure the disk cache instead of a lingering session.
 *
 * Each run copies the pristine fixture, starts a fresh daemon (its projection caches cold) and measures:
 * - cold start: connect, then the lists and the restored long thread together (as `state.ts` does on `open`);
 * - first opens of the short and medium threads on that daemon (projection cold);
 * - `--warm` repeats of: the list refresh, and opening short, medium and long again after leaving them
 *   (the "recently seen" case; `current` has no cache, so it pays a full open);
 * - an open of a thread never opened by this client (others[i]), projection cold.
 * `--rtt`/`--mbps` put `linkProxy` between client and daemon (a remote-machine stand-in).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { freshCopy, readFixture, startDaemon, SCRATCH } from './scratch.ts'
import { linkProxy, median, meteredClient, p95, type Meter } from './meter.ts'
import { currentFlow, type Flow } from './flows.ts'

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : fallback }
// `--url ws://host:port/ws --token <t>`: an already running daemon (another machine serving a copy of the fixture);
// nothing is started or copied, so its caches are only cold on the first run.
const remoteUrl = arg('url'), remoteToken = arg('token')
const exe = arg('daemon') ?? (remoteUrl ? '' : (() => { throw Error('--daemon <kybernd> (or --url and --token) is required') })())
const flowName = arg('flow', 'current')!
const label = arg('label', flowName)!
const runs = Number(arg('runs', '8')), warm = Number(arg('warm', '5'))
const rtt = Number(arg('rtt', '0')), mbps = Number(arg('mbps', '0'))
const out = path.resolve(arg('out', path.join(import.meta.dir, 'results', `${label}${rtt ? `-rtt${rtt}` : ''}.json`))!)
const DAEMON_PORT = 4421, PROXY_PORT = 4422
const MACHINE = 'bench-local'

async function loadFlow(): Promise<Flow> {
  if (flowName === 'current') return currentFlow
  const { instantFlow } = await import('./instant.ts')
  return instantFlow(path.join(SCRATCH, `cache-${label}${rtt ? `-rtt${rtt}` : ''}.sqlite`), { linger: arg('linger', '1') !== '0' })
}

type Sample = Record<string, unknown> & { case: string; ms: number }
const samples: Sample[] = []
const fixture = readFixture()
const flow = await loadFlow()

async function openCase(name: string, meter: Meter, run: () => Promise<Awaited<ReturnType<Flow['open']>>>, extra: Record<string, unknown> = {}) {
  const from = meter.mark()
  const opened = await run()
  const content = meter.span(from, from.at + opened.contentAt)
  const live = meter.span(from)
  samples.push({ case: name, ms: opened.contentAt, liveMs: opened.liveAt, from: opened.from, blocks: opened.blocks, roundTrips: content.roundTrips, bytes: content.bytes, calls: content.calls, liveBytes: live.bytes, liveCalls: live.calls, ...extra })
  return opened
}

for (let run = 0; run < runs; run++) {
  const daemon = remoteUrl
    ? { url: remoteUrl, token: remoteToken ?? '', spawnMs: NaN, stop: async () => {} }
    : await startDaemon(path.resolve(exe), freshCopy(`run-${label}`), DAEMON_PORT)
  const proxy = rtt || mbps ? linkProxy(PROXY_PORT, daemon.url, rtt, mbps) : undefined
  try {
    // ---- cold start: the app connects, then reads the lists and restores its open thread at once ----
    const { client, meter, connectMs } = await meteredClient(proxy?.url ?? daemon.url, daemon.token)
    samples.push({ case: 'daemon-spawn', ms: daemon.spawnMs, run })
    samples.push({ case: 'connect', ms: connectMs, run })
    const start = meter.mark()
    const lists = flow.lists(client, true).then(r => ({ ...r, at: performance.now() - start.at }))
    const restored = openCase('cold-restore-long', meter, () => flow.open(client, fixture.long, MACHINE), { run })
    const listed = await lists
    samples.push({ case: 'cold-lists', ms: listed.at, rows: listed.threads, projects: listed.projects, ...meter.span(start, start.at + listed.at), run })
    ;(await restored).close(); await flow.closed?.(client, fixture.long, MACHINE)

    // ---- first opens on this daemon (its projection cache cold for these threads) ----
    for (const [role, id] of [['short', fixture.short], ['medium', fixture.medium]] as const) {
      const opened = await openCase(`first-open-${role}`, meter, () => flow.open(client, id, MACHINE), { run })
      opened.close(); await flow.closed?.(client, id, MACHINE)
    }
    const unseen = fixture.others[run % fixture.others.length]!
    const u = await openCase('unseen-open-small', meter, () => flow.open(client, unseen, MACHINE), { run })
    u.close(); await flow.closed?.(client, unseen, MACHINE)

    // ---- warm: list refreshes and reopening recently seen threads ----
    for (let i = 0; i < warm; i++) {
      const at = meter.mark()
      const r = await flow.lists(client, false)
      samples.push({ case: 'warm-list-refresh', ms: performance.now() - at.at, rows: r.threads, ...meter.span(at), run })
      for (const [role, id] of [['short', fixture.short], ['medium', fixture.medium], ['long', fixture.long]] as const) {
        const opened = await openCase(`reopen-${role}`, meter, () => flow.open(client, id, MACHINE), { run })
        opened.close(); await flow.closed?.(client, id, MACHINE)
      }
    }
    client.close()
  } finally {
    proxy?.stop()
    await daemon.stop()
  }
  process.stderr.write(`run ${run + 1}/${runs} done\n`)
}
await flow.dispose?.()

const cases = [...new Set(samples.map(s => s.case))]
const summary = Object.fromEntries(cases.map(name => {
  const xs = samples.filter(s => s.case === name)
  const num = (key: string) => xs.map(s => Number(s[key])).filter(Number.isFinite)
  return [name, {
    n: xs.length, medianMs: +median(num('ms')).toFixed(1), p95Ms: +p95(num('ms')).toFixed(1),
    ...(xs[0]!.liveMs !== undefined ? { liveMedianMs: +median(num('liveMs')).toFixed(1) } : {}),
    ...(xs[0]!.roundTrips !== undefined ? { roundTrips: median(num('roundTrips')), bytes: median(num('bytes')) } : {}),
    ...(xs[0]!.from !== undefined ? { from: [...new Set(xs.map(s => s.from))].join('/') } : {}),
    ...(xs[0]!.blocks !== undefined ? { blocks: median(num('blocks')) } : {}),
    ...(xs[0]!.rows !== undefined ? { rows: median(num('rows')) } : {}),
  }]
}))
const result = { label, flow: flow.name, daemon: remoteUrl ? 'remote' : path.basename(exe), rttMs: rtt, mbps, runs, warm, at: new Date().toISOString(), host: { platform: process.platform, bun: Bun.version }, fixture: { ...fixture, others: fixture.others.length }, summary, samples }
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(result, null, 2))
console.table(summary)
console.log(`wrote ${out}`)
