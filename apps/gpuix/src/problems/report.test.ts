import { describe, expect, test } from 'bun:test'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { describeProblem } from '../../../../packages/kybern-client/src/problems.ts'
import { draftFor, osLabel } from './report.ts'
import { problemProps } from './props.ts'

const fail = (problem: object) => new RpcCallError({ code: -32010, message: 'x', data: { problem } })

describe('report a problem', () => {
  test('a problem that has technical text offers a report, which opens the review', () => {
    const view = describeProblem(fail({ kind: 'internal', detail: 'boom' }), { action: 'rename the thread' })
    expect(typeof problemProps(view, {}).onReport).toBe('function')
  })

  test('the draft carries no path, user name, machine name, e-mail address or token', () => {
    const detail = 'run gh: C:\\Users\\bagus\\scoop\\shims\\gh.exe failed on SatyaMas for bagus@example.com with ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const view = describeProblem(fail({ kind: 'internal', detail }), { action: 'load pull requests' })
    const draft = draftFor(view, { environment: { app: '0.21.8', os: 'Windows 10.0.26300', arch: 'x64' }, names: { users: ['bagus'], machines: ['SatyaMas'] } })
    const text = `${draft.title}\n${draft.body}`
    for (const leak of ['bagus', 'C:\\Users', 'SatyaMas', 'example.com', 'ghp_']) expect(text).not.toContain(leak)
    expect(draft.body).toContain('run gh: <path> failed on <machine> for <email> with <secret>')
    expect(draft.body).toContain('- Kybern 0.21.8')
  })

  test('the OS is named the way a person names it', () => {
    expect(osLabel('win32', '10.0.26300')).toBe('Windows 10.0.26300')
    expect(osLabel('darwin', '25.1.0')).toBe('macOS (Darwin 25.1.0)')
    expect(osLabel('linux', '6.8.0')).toBe('Linux 6.8.0')
  })
})
