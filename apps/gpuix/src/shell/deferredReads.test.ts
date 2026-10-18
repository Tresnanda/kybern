import { expect, test } from 'bun:test'
import { DeferredReads } from './deferredReads.ts'

test('background metadata stays bounded and newest queued work goes first', async () => {
  const pool = new DeferredReads(4), started: number[] = [], release: (() => void)[] = []
  let active = 0, peak = 0
  const pending = Array.from({ length: 80 }, (_, id) => pool.run(async () => {
    started.push(id); active++; peak = Math.max(peak, active)
    await new Promise<void>(resolve => release.push(resolve))
    active--; return id
  }))
  await Bun.sleep(0)
  expect(started).toEqual([79, 78, 77, 76])
  expect(peak).toBe(4)
  // New navigation takes precedence over the older rows still queued.
  const newest = pool.run(async () => { started.push(80); return 80 })
  release.shift()!(); await Bun.sleep(0)
  expect(started[4]).toBe(80)
  for (let i = 0; i < 80; i++) { for (const end of release.splice(0)) end(); await Bun.sleep(0) }
  expect(await newest).toBe(80)
  expect(await Promise.all(pending)).toEqual(Array.from({ length: 80 }, (_, id) => id))
  expect(peak).toBe(4)
})

test('rejected and synchronously failing reads release their capacity', async () => {
  const pool = new DeferredReads(1)
  const rejected = pool.run(async () => { throw Error('rejected') }).catch(error => error.message)
  await Bun.sleep(0)
  const sync = pool.run(() => { throw Error('sync') }).catch(error => error.message)
  const next = pool.run(async () => 'next')
  expect(await rejected).toBe('rejected')
  expect(await sync).toBe('sync')
  expect(await next).toBe('next')
})
