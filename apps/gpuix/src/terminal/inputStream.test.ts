import { expect, test } from 'bun:test'
import { createInputStream, MAX_INPUT_FRAME } from './inputStream.ts'

const text = (base64: string) => Buffer.from(base64, 'base64').toString('latin1')

/** A write that finishes after a random delay, like an RPC over a slow link, and records how many ran at once. */
function slowWire() {
  const received: string[] = []
  let active = 0, peak = 0
  const write = async (base64: string) => {
    active++; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 3))
    received.push(text(base64)); active--
  }
  return { write, received, peak: () => peak }
}

test('500 fast keystrokes arrive in order, never two writes at once', async () => {
  const wire = slowWire()
  const stream = createInputStream(wire.write, (e) => { throw e })
  const sent = Array.from({ length: 500 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
  for (const char of sent) stream.push(Buffer.from(char))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(wire.received.join('')).toBe(sent)
  expect(wire.peak()).toBe(1)
  // The first key goes out at once; the rest ride together while it is in flight.
  expect(wire.received.length).toBeLessThan(50)
})

test('a large paste is split into ordered frames', async () => {
  const wire = slowWire()
  const stream = createInputStream(wire.write, (e) => { throw e })
  const paste = 'x'.repeat(MAX_INPUT_FRAME * 2 + 5)
  stream.push(Buffer.from(paste))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(wire.received.join('')).toBe(paste)
  expect(wire.received.every((frame) => frame.length <= MAX_INPUT_FRAME)).toBe(true)
})

test('a failed write reports once, drops what was behind it and recovers', async () => {
  const errors: unknown[] = []
  const received: string[] = []
  let fail = true
  const stream = createInputStream(async (base64) => { if (fail) { fail = false; throw new Error('down') } received.push(text(base64)) }, (e) => errors.push(e))
  stream.push(Buffer.from('a')); stream.push(Buffer.from('b'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  stream.push(Buffer.from('c'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(errors.length).toBe(1)
  expect(received).toEqual(['c'])
})

test('close stops sending', async () => {
  const received: string[] = []
  const stream = createInputStream(async (base64) => { received.push(text(base64)) }, () => {})
  stream.close(); stream.push(Buffer.from('a'))
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(received).toEqual([])
})
