import { describe, expect, mock, test } from 'bun:test'
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

  test('choose_model opens the composer model picker, and is absent without one', () => {
    let opens = 0
    expect(resolveAction(action('choose_model', { provider: 'antigravity' }), {})).toBeNull()
    const button = resolveAction(action('choose_model', { provider: 'antigravity' }), { chooseModel: () => { opens++ } }, 'pick-model')
    expect(button).toMatchObject({ label: 'Label for choose_model', testId: 'pick-model' })
    button!.onClick()
    expect(opens).toBe(1)
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

  test('a failed turn never signs in Antigravity’s own login: it opens Accounts, or adds a new account', async () => {
    const dialogs = { ...(await import('../dialogs/store.ts')) }
    const settings = { ...(await import('../settings/SettingsScreen.tsx')) }
    const opened: unknown[] = []
    const tabs: string[] = []
    mock.module('../dialogs/store.ts', () => ({ ...dialogs, showDialog: (dialog: unknown) => { opened.push(dialog) } }))
    mock.module('../settings/SettingsScreen.tsx', () => ({ ...settings, openSettingsTab: (tab: string) => { tabs.push(tab) } }))
    try {
      const press = async (id: string, params: Record<string, string>) => {
        resolveAction(action(id, params), {})!.onClick()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await press('sign_in', { provider: 'antigravity', instance: 'default' })
      expect([tabs, opened]).toEqual([['accounts'], []])
      // A named account signs in again; "Use another account" names none, so the sheet adds one.
      await press('sign_in', { provider: 'antigravity', instance: 'a1' })
      await press('use_another_account', { provider: 'antigravity' })
      // Claude Code's terminal login is signed in only while signed out, which the daemon checks.
      await press('sign_in', { provider: 'claude', instance: 'default' })
      expect(opened).toEqual([{ kind: 'account', provider: 'antigravity', instance: 'a1' }, { kind: 'account', provider: 'antigravity' }, { kind: 'account', provider: 'claude-code', instance: 'default' }])
    } finally {
      mock.module('../dialogs/store.ts', () => dialogs)
      mock.module('../settings/SettingsScreen.tsx', () => settings)
    }
  })

  test('a failed turn offers another account and an agent update only for an agent Kybern knows', () => {
    for (const id of ['use_another_account', 'update_agent']) {
      for (const provider of ['claude', 'codex', 'cursor', 'antigravity', 'grok']) expect(resolveAction(action(id, { provider }), {}), `${id} ${provider}`).not.toBeNull()
      expect(resolveAction(action(id, { provider: 'unknown' }), {})).toBeNull()
      expect(resolveAction(action(id), {})).toBeNull()
    }
  })
})
