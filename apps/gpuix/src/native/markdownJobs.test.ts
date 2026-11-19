import { expect, test } from 'bun:test'
import { MARKDOWN_JOB_LIMIT, MarkdownJobCancelled, MarkdownJobQueue } from './markdownJobs.ts'

const tick = () => Bun.sleep(1)
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

test('never has more than the limit in flight and runs the rest in order', async () => {
  const queue = new MarkdownJobQueue()
  const gates = Array.from({ length: 20 }, () => deferred<number>())
  const started: number[] = []
  const tickets = gates.map((gate, i) => queue.submit(() => { started.push(i); return gate.promise }))
  expect(started).toEqual([0, 1, 2, 3, 4, 5])
  expect(MARKDOWN_JOB_LIMIT).toBeLessThan(8)
  expect(queue.stats).toEqual({ running: 6, queued: 14 })
  gates[0]!.resolve(0); await tick()
  expect(started.at(-1)).toBe(6)
  for (let i = 1; i < 20; i++) { gates[i]!.resolve(i); await tick() }
  expect(await Promise.all(tickets.map(t => t.result))).toEqual(Array.from({ length: 20 }, (_, i) => i))
  expect(started).toEqual(Array.from({ length: 20 }, (_, i) => i))
  expect(queue.stats).toEqual({ running: 0, queued: 0 })
})

test('cancel drops a queued job and leaves a started one running', async () => {
  const queue = new MarkdownJobQueue({ limit: 1 })
  const first = deferred<string>()
  const ran: string[] = []
  const a = queue.submit(() => { ran.push('a'); return first.promise })
  const b = queue.submit(async () => { ran.push('b'); return 'b' })
  const bFailed = b.result.catch(e => e)
  b.cancel(); a.cancel()
  expect(await bFailed).toBeInstanceOf(MarkdownJobCancelled)
  first.resolve('a'); expect(await a.result).toBe('a')
  await tick()
  expect(ran).toEqual(['a'])
})

test('a queue-full answer waits and retries instead of failing', async () => {
  // Native shared with another caller: it refuses until `open` is set.
  let open = false, calls = 0
  const queue = new MarkdownJobQueue({ retryFirstMs: 1, retryMaxMs: 2 })
  const ticket = queue.submit(async () => { calls++; if (!open) throw Error('Markdown queue is full (8 jobs)'); return 'ok' })
  await Bun.sleep(15)
  expect(calls).toBeGreaterThan(1)
  open = true
  expect(await ticket.result).toBe('ok')
})

test('a worker that stays full gives up with its own error; other failures pass straight through', async () => {
  let clock = 0
  const queue = new MarkdownJobQueue({ giveUpMs: 100, now: () => clock, retryFirstMs: 1, retryMaxMs: 1 })
  const stuck = queue.submit(async () => { clock += 60; throw Error('Markdown queue is full (8 jobs)') })
  await expect(stuck.result).rejects.toThrow('queue is full')
  await expect(queue.submit(async () => { throw Error('parse failed') }).result).rejects.toThrow('parse failed')
  expect(queue.stats).toEqual({ running: 0, queued: 0 })
})

test('a high priority job goes ahead of waiting normal ones', async () => {
  const queue = new MarkdownJobQueue({ limit: 1 })
  const gate = deferred<void>(), order: string[] = []
  queue.submit(() => gate.promise)
  const normal = queue.submit(async () => { order.push('normal') })
  const high = queue.submit(async () => { order.push('high') }, 'high')
  gate.resolve(); await Promise.all([normal.result, high.result])
  expect(order).toEqual(['high', 'normal'])
})
