import { describe, expect, test } from 'bun:test'
import { PROBLEM_ACTIONS, resolveAction } from './actions.ts'

const action = (id: string, params?: Record<string, string>) => ({ id, label: `Label for ${id}`, ...(params ? { params } : {}) })

describe('problem actions', () => {
  test('an unknown action id renders no button', () => {
    expect(resolveAction(action('format_disk'), { retry: () => {} })).toBeNull()
    expect(resolveAction(action('constructor'), {})).toBeNull()
    expect(resolveAction(action('toString'), {})).toBeNull()
    expect(resolveAction(undefined, {})).toBeNull()
  })

  test('every id the issue names is in the table', () => {
    for (const id of ['install_tool', 'sign_in', 'open_settings', 'retry', 'copy_details', 'copy_detail', 'update', 'open_machines']) expect(Object.keys(PROBLEM_ACTIONS)).toContain(id)
  })

  test('retry runs the surface’s own retry, and is absent without one', () => {
    let runs = 0
    expect(resolveAction(action('retry'), {})).toBeNull()
    const button = resolveAction(action('retry'), { retry: () => { runs++ } }, 'again')
    expect(button).toMatchObject({ label: 'Label for retry', testId: 'again' })
    button!.onClick()
    expect(runs).toBe(1)
  })

  test('copying needs something to copy', () => {
    expect(resolveAction(action('copy_details'), {})).toBeNull()
    expect(resolveAction(action('copy_detail'), { detail: 'run gh: program not found' })).not.toBeNull()
  })

  test('install_tool is offered only for a tool Kybern can install', () => {
    expect(resolveAction(action('install_tool', { tool: 'gh' }), {})).not.toBeNull()
    expect(resolveAction(action('install_tool', { tool: 'claude' }), {})).not.toBeNull()
    expect(resolveAction(action('install_tool', { tool: 'ffmpeg' }), {})).toBeNull()
    expect(resolveAction(action('install_tool'), {})).toBeNull()
  })

  test('sign_in, open_settings and update are always offered', () => {
    for (const id of ['sign_in', 'open_settings', 'update', 'open_machines']) expect(resolveAction(action(id), {})).not.toBeNull()
  })
})
