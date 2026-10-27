import { describe, expect, test } from 'bun:test'
import { createPress } from './once.ts'

describe('press guard', () => {
  test('a second press inside the window is dropped, a later one runs', () => {
    let now = 1000
    const press = createPress(500, () => now)
    let runs = 0
    expect(press(() => runs++)).toBe(true)
    now += 120
    expect(press(() => runs++)).toBe(false)
    now += 379
    expect(press(() => runs++)).toBe(false)
    now += 2
    expect(press(() => runs++)).toBe(true)
    expect(runs).toBe(2)
  })
})
