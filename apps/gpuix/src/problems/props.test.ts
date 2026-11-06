import { describe, expect, test } from 'bun:test'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { describeProblem } from '../../../../packages/kybern-client/src/problems.ts'
import type { ProblemKind } from '../../../../packages/kybern-client/src/types.ts'
import { problemLook, problemProps } from './props.ts'

const fail = (problem: object) => new RpcCallError({ code: -32010, message: 'x', data: { problem } })
const noop = () => {}

describe('problem props', () => {
  test('a missing tool is an info state with an Install button and Check again', () => {
    const view = describeProblem(fail({ kind: 'tool_missing', subject: 'gh', detail: 'run gh: program not found' }), { action: 'load pull requests', goal: 'see pull requests' })
    const props = problemProps(view, { retry: noop }, 'pr-problem')
    expect(props).toMatchObject({ tone: 'info', icon: 'console', title: 'Install GitHub CLI to see pull requests', testId: 'pr-problem', detail: 'run gh: program not found' })
    expect([props.primary?.label, props.secondary?.label]).toEqual(['Install GitHub CLI', 'Check again'])
  })

  test('an action the surface cannot run leaves the next one leading', () => {
    const view = describeProblem(fail({ kind: 'tool_missing', subject: 'gh', detail: 'x' }), { action: 'load pull requests' })
    const props = problemProps(view, {})
    expect(props.primary?.label).toBe('Install GitHub CLI')
    expect(props.secondary).toBeUndefined()
  })

  test('copy is the disclosure’s button, never a second one', () => {
    const view = describeProblem(fail({ kind: 'internal', detail: 'boom: at line 3' }), { action: 'rename the thread' })
    expect(view.secondary?.id).toBe('copy_detail')
    const props = problemProps(view, { retry: noop })
    expect([props.primary?.label, props.secondary]).toEqual(['Try again', undefined])
  })

  test('every kind has a tone and a glyph', () => {
    const kinds: ProblemKind[] = ['tool_missing', 'signed_out', 'permission', 'offline', 'conflict', 'invalid_input', 'not_found', 'update_needed', 'internal']
    expect(kinds.map((kind) => problemLook(kind).tone)).toEqual(['info', 'warning', 'warning', 'neutral', 'warning', 'warning', 'neutral', 'info', 'danger'])
    expect(new Set(kinds.map((kind) => problemLook(kind).icon)).size).toBeGreaterThan(3)
  })
})
