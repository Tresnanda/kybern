import { describe, expect, test } from 'bun:test'
import { chooseTab, closeTab, dockGeometry, getDock, setDock } from './store.ts'

describe('dock layout and thread choices', () => {
  test('reserves 320px for chat and overlays below 736px of available space', () => {
    expect(dockGeometry(1280, 256, 900)).toEqual({ overlay: false, max: 644, width: 644 })
    expect(dockGeometry(980, 256, 900)).toEqual({ overlay: true, max: 664, width: 664 })
    expect(dockGeometry(980, 0, 200)).toEqual({ overlay: false, max: 600, width: 416 })
  })
  test('closing the active tab chooses its neighbour, then leaves a real empty strip', () => {
    const id = 'dock-test-close'
    setDock(id, { tabs: ['agents', 'changes', 'activity'], tab: 'changes', open: true })
    closeTab(id, 'changes')
    expect(getDock(id).tab).toBe('activity')
    closeTab(id, 'activity')
    expect(getDock(id).tab).toBe('agents')
    closeTab(id, 'agents')
    expect(getDock(id).tabs).toEqual([])
    expect(getDock(id).tab).toBeNull()
    expect(getDock(id).open).toBe(true)
  })
  test('tabs and widths stay with their thread and choosing an open tab never duplicates it', () => {
    setDock('dock-test-a', { width: 600, open: true })
    chooseTab('dock-test-a', 'explorer')
    chooseTab('dock-test-a', 'explorer')
    chooseTab('dock-test-b', 'changes')
    expect(getDock('dock-test-a').tabs).toEqual(['agents', 'explorer'])
    expect(getDock('dock-test-a').width).toBe(600)
    expect(getDock('dock-test-b').tabs).toEqual(['agents', 'changes'])
    expect(getDock('dock-test-b').open).toBe(false)
  })
})
