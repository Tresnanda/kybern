// Native fixture for Settings › Accounts › Login broker: the harness rows on the broker (with its loans) and on a
// borrower. No daemon or machine is touched. Drive it with `broker.shots.ts`.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { seedBroker } from '../machines/broker.ts'
import { Section } from './controls.tsx'
import { HarnessRow } from './LoginBroker.tsx'
import type { LoginBrokerStatus } from '../../../../packages/kybern-client/src/types.ts'

const NAMES = { mac: 'MacBook', vps: 'VPS', pc: 'Windows PC' }
const provider = (kind: 'claude-code' | 'codex', state: string, extra = {}) => ({ provider: kind, state, lendable: [], sessions: 0, ...extra })
const lendable = (kind: 'claude-code' | 'codex') => [{ provider: kind, account: 'default', name: 'CLI account', plan: 'Max' }]
const BROKER = { machine_id: 'mac', name: 'MacBook', reachable: true }
// MacBook is the broker: Codex lent to two machines, Claude Code to none, and omp has no row at all.
const AS_BROKER = { broker: BROKER, is_broker: true, providers: [provider('claude-code', 'lending', { lendable: lendable('claude-code') }), provider('codex', 'lending', { lendable: lendable('codex') })], loans: [
  { loan_id: 'l1', machine_id: 'vps', provider: 'codex', account: 'default', created_at: '2026-10-29T14:02:00+08:00' },
  { loan_id: 'l2', machine_id: 'pc', provider: 'codex', account: 'default', created_at: '2026-10-29T15:40:00+08:00', last_error: 'Windows PC did not answer the last refresh' },
] } as unknown as LoginBrokerStatus
const AS_BORROWER = { broker: BROKER, is_broker: false, providers: [provider('claude-code', 'borrowing', { local_account: 'a', broker_account: 'default' }), provider('codex', 'not_used', { lendable: lendable('codex') })], loans: [] } as unknown as LoginBrokerStatus
const borrower = process.env.BROKER_FIXTURE === 'borrower'
seedBroker(borrower ? AS_BORROWER : AS_BROKER)

function Fixture() {
  const t = useTheme()
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 24, backgroundColor: t.surface }}>
    <Section title={borrower ? 'On a borrower' : 'On the broker (MacBook)'}><HarnessRow kind="claude-code" names={NAMES} /><HarnessRow kind="codex" names={NAMES} /></Section>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Login broker', width: 860, height: 560, focus: false })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
