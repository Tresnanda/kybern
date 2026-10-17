import { beforeEach, describe, expect, test } from 'bun:test'
import { HoverController, resetHoverWorld, visibleHoverPopup, type Timers } from './hoverController.ts'

/** A manual clock: timers fire when `advance` passes them. */
function clock() {
  let now = 1000
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => { pending.set(++seq, { at: now + ms, fn }); return seq },
    clear: (h) => { pending.delete(h as number) },
    now: () => now,
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      pending.delete(next[0])
      next[1].fn()
    }
    now = end
  }
  return { timers, advance }
}
const tooltip = (c: ReturnType<typeof clock>) => new HoverController<true>({ delay: 600, skip: 300 }, () => {}, c.timers)

describe('HoverController', () => {
  beforeEach(resetHoverWorld)

  test('opens after the delay and closes at once on leave', () => {
    const c = clock(), tip = tooltip(c)
    tip.enter(true)
    c.advance(599)
    expect(tip.active).toBeNull()
    c.advance(2)
    expect(tip.active).toBe(true)
    tip.leave()
    expect(tip.active).toBeNull()
  })

  test('an enter and a leave in one tick leave nothing open (R4-1: the closure dropped this close)', () => {
    const c = clock(), a = tooltip(c), b = tooltip(c)
    a.enter(true); a.leave()
    c.advance(100)
    b.enter(true) // within the skip window of nothing: a never opened, so b waits the full delay
    expect(b.active).toBeNull()
    b.leave()
    c.advance(2000)
    expect(a.active).toBeNull()
    expect(b.active).toBeNull()
    expect(visibleHoverPopup()).toBeNull()
  })

  test('instant open and leave in the same tick still close', () => {
    const c = clock(), a = tooltip(c), b = tooltip(c)
    a.enter(true); c.advance(700)
    a.leave()                // a closes: the skip window opens
    b.enter(true)            // opens synchronously (skip path)
    expect(b.active).toBe(true)
    expect(b.instant).toBe(true)
    b.leave()                // before any render
    expect(b.active).toBeNull()
    expect(visibleHoverPopup()).toBeNull()
  })

  test('the next trigger entering before the previous one leaves hands over instantly and leaves one popup', () => {
    const c = clock(), a = tooltip(c), b = tooltip(c)
    a.enter(true); c.advance(700)
    b.enter(true)            // GPUI delivered b's enter first
    expect(a.active).toBeNull()
    expect(b.active).toBe(true)
    expect(b.instant).toBe(true)
    a.leave()                // late leave of the old trigger changes nothing
    expect(b.active).toBe(true)
    b.leave()
    expect(visibleHoverPopup()).toBeNull()
  })

  test('at most one popup is visible: a lost leave heals when another opens', () => {
    const c = clock(), a = tooltip(c), b = tooltip(c)
    a.enter(true); c.advance(700)
    expect(a.active).toBe(true)
    // a's leave is never delivered.
    c.advance(5000)
    b.enter(true); c.advance(700)
    expect(a.active).toBeNull()
    expect(b.active).toBe(true)
  })

  test('the skip window ends after 300 ms', () => {
    const c = clock(), a = tooltip(c), b = tooltip(c)
    a.enter(true); c.advance(700); a.leave()
    c.advance(301)
    b.enter(true)
    expect(b.active).toBeNull()
    c.advance(600)
    expect(b.active).toBe(true)
    expect(b.instant).toBe(false)
  })

  test('a leave cancels a pending open', () => {
    const c = clock(), tip = tooltip(c)
    tip.enter(true); c.advance(300); tip.leave(); c.advance(1000)
    expect(tip.active).toBeNull()
  })

  test('a card stays open while the pointer is on it and closes after the close delay', () => {
    const c = clock()
    const card = new HoverController<true>({ delay: 80, closeDelay: 100, hoverable: true }, () => {}, c.timers)
    card.enter(true); c.advance(81)
    expect(card.active).toBe(true)
    card.leave(); c.advance(50)
    card.popupEnter(); c.advance(500)
    expect(card.active).toBe(true)
    card.popupLeave(); c.advance(99)
    expect(card.active).toBe(true)
    c.advance(2)
    expect(card.active).toBeNull()
  })

  test('returning to the trigger cancels the close', () => {
    const c = clock()
    const card = new HoverController<string>({ delay: 80, closeDelay: 100, hoverable: true }, () => {}, c.timers)
    card.enter('a'); c.advance(81)
    card.leave(); c.advance(60)
    card.enter('b'); c.advance(500)
    expect(card.active).toBe('b')
    expect(card.carried).toBe(true)
    expect(card.instant).toBe(true)
  })

  test('a tooltip inside a card does not close the card; an unrelated tooltip does', () => {
    const c = clock()
    const card = new HoverController<true>({ delay: 0, hoverable: true }, () => {}, c.timers)
    const inner = new HoverController<true>({ delay: 600, skip: 300, parent: card as never }, () => {}, c.timers)
    const other = tooltip(c)
    card.enter(true)
    expect(card.active).toBe(true)
    inner.enter(true); c.advance(700)
    expect(inner.active).toBe(true)
    expect(card.active).toBe(true)
    other.enter(true); c.advance(700)
    expect(other.active).toBe(true)
    expect(inner.active).toBeNull()
  })

  test('dispose releases the slot', () => {
    const c = clock(), tip = tooltip(c)
    tip.enter(true); c.advance(700)
    tip.dispose()
    expect(visibleHoverPopup()).toBeNull()
  })
})
