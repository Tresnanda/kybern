// The flow store: scene moves are explicit, a late or doubled press moves nothing, and a new environment starts the run over.
import { beforeEach, describe, expect, test } from 'bun:test'
import { flow, goFrom, openFlow, resetFlow } from './flow.ts'

beforeEach(() => { resetFlow(); openFlow() })

describe('goFrom', () => {
  test('moves only from the scene on screen', () => {
    expect(flow.get().scene).toBe('hero')
    expect(goFrom('hero', 'agents')).toBe(true)
    expect(flow.get()).toMatchObject({ scene: 'agents', dir: 1 })
    // The same press again, and a press from a scene that has gone, change nothing: no scene is skipped.
    expect(goFrom('hero', 'agents')).toBe(false)
    expect(goFrom('agents', 'projects')).toBe(true)
    expect(goFrom('agents', 'projects')).toBe(false)
    expect(flow.get().scene).toBe('projects')
  })
  test('Back moves one scene and never past the first', () => {
    goFrom('hero', 'agents')
    expect(goFrom('agents', 'hero')).toBe(true)
    expect(flow.get()).toMatchObject({ scene: 'hero', dir: -1 })
    expect(goFrom('agents', 'hero')).toBe(false)
  })
})

describe('resetFlow', () => {
  test('a new environment starts over: closed, hero, not finished', () => {
    goFrom('hero', 'agents')
    flow.set({ finished: true, open: false })
    resetFlow()
    expect(flow.get()).toMatchObject({ open: false, scene: 'hero', finished: false, releasing: false, handoff: null, only: false })
  })
})
