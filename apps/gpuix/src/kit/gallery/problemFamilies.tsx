// Phase 3 of the actionable errors (#232), families 1 to 3, as the app words them: every card is built from a real failure through the
// code the app runs (`describe`, `problemProps`, `sendFailure`, `partialCopy`, `failureLine`), not from copy typed here.
// `KIT_SECTION=problem-families`; `scripts/problem-families-check.ts` asserts and captures it.
import type { ComponentType } from 'react'
import { RpcCallError } from '../../../../../packages/kybern-client/src/client.ts'
import { OfflineError } from '../../../../../packages/kybern-client/src/machineClient.ts'
import { sendFailure } from '../../composer/failure.ts'
import { describe, problemLine } from '../../problems/describe.ts'
import { problemProps } from '../../problems/props.ts'
import { partialCopy } from '../../pulls/partialCopy.ts'
import { failureLine } from '../../shell/Connection.tsx'
import { Label, useTheme } from '../../ui.tsx'
import { ProblemRow, ProblemState } from '../Problem.tsx'

const rpc = (code: number, message: string, problem?: object) => new RpcCallError({ code, message, ...(problem ? { data: { problem } } : {}) })
const noop = () => {}

const missing = (tool: string, detail: string) => rpc(-32010, detail, { kind: 'tool_missing', subject: tool, detail })

/** Pane states (family 2 and 3): the Review pane without Git, a machine that is away, Tailscale missing. */
const STATES = [
  problemProps(describe(missing('git', 'run git: program not found'), { action: 'load this branch', goal: 'see this branch' }), { retry: noop }, 'fam-state-0'),
  problemProps(describe(new OfflineError('sm', false, 'SatyaMas is offline. Try again when it reconnects.'), { action: 'open the thread' }, () => undefined), { retry: noop }, 'fam-state-1'),
  problemProps(describe(missing('tailscale', 'Tailscale is not installed on this machine: run tailscale: program not found'), { action: 'turn on the network', goal: 'turn on the network' }), { retry: noop }, 'fam-state-2'),
]

/** Rows (family 1 to 3): a harness that is not installed, Node.js for Cursor, pull requests that only partly listed. */
const partial = partialCopy(['kybern / app', 'docs'], true)
const ROWS = [
  problemProps(describe(new Error('run claude: program not found'), { action: 'finish this reply' }), {}, 'fam-row-0'),
  problemProps(describe(new Error('Cursor’s SDK installs with npm, which comes with Node.js. Install Node.js, then try again.'), { action: 'set up Cursor' }), { retry: noop }, 'fam-row-1'),
  { tone: 'warning' as const, icon: 'alert', title: partial.title, body: partial.body, detail: 'kybern / app: gh: could not resolve to a Repository', primary: { label: 'Try again', onClick: noop }, testId: 'fam-row-2' },
]

/** One-line forms (a composer line, the connection banner). */
const LINES = [
  ['Composer', sendFailure(new OfflineError('sm', false, 'SatyaMas is offline. Try again when it reconnects.'))],
  ['Attach', problemLine(rpc(-32602, 'invalid params: missing field `name` at line 1'), { action: 'attach the image' })],
  ['Banner', failureLine('connect ECONNREFUSED 127.0.0.1:4199', 'SatyaMas', false)],
] as const

function Families() {
  const t = useTheme()
  return (
    <div style={{ position: 'relative', width: 1280, height: 820 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1280, height: 400, display: 'flex' }}>
        {STATES.map((props, i) => (
          <div key={i} style={{ display: 'flex', width: 426, flexShrink: 0, borderLeftWidth: i ? 1 : 0, borderColor: t.border }}><ProblemState {...props} /></div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, top: 400, width: 1280, height: 230, borderTopWidth: 1, borderColor: t.border, display: 'flex' }}>
        {ROWS.map((props, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', width: 420, padding: 20, flexShrink: 0 }}><ProblemRow {...props} /></div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, top: 630, width: 1280, height: 190, borderTopWidth: 1, borderColor: t.border, display: 'flex', flexDirection: 'column', gap: 8, padding: 20 }}>
        {LINES.map(([label, line]) => (
          <div key={label} testId={`fam-line-${label.toLowerCase()}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Label color={t.textTertiary} size={11}>{label}</Label>
            <Label color={t.red} size={12} lineHeight={17}>{line}</Label>
          </div>
        ))}
      </div>
    </div>
  )
}

export const sections: Record<string, ComponentType> = { 'problem-families': Families }
