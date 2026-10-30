// Deterministic ADE-101 fixture: all RPCs stay in memory and every writable path is scratch.
import '../native/local-build.ts'
import { writeFileSync } from 'node:fs'
import { render } from '@gpuix/react'
import { useState } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ProvisionPlan, ProvisionStatus } from '../../../../packages/kybern-client/src/types.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { MachinePicker } from '../composer/MachinePicker.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { MachineSetupSheet } from './MachineSetupSheet.tsx'
import { setProvisionFixture } from './targets.ts'

if (!process.env.KYBERN_DATA_DIR || !process.env.SETUP_STATE_PATH) throw new Error('Scratch fixture paths required')
const evidence = { requests: [] as Record<string, unknown>[], selected: 'Mac', selections: 0, mappings: [] as string[], draft: 'Keep this draft and its repository choices', closed: 0 }
const save = () => writeFileSync(process.env.SETUP_STATE_PATH!, JSON.stringify(evidence))
const listeners = new Set<(params: unknown) => void>()
const operations = new Map<string, ProvisionStatus>()
const tries = new Map<string, number>()
const names: Record<string, string> = { pc: 'Windows PC', vps: 'Build server', offline: 'Travel laptop' }
const plan = (id: string, asked?: string): ProvisionPlan => ({
  project_id: 'source', project_name: 'Launch workspace', kind: 'group',
  source: { id: 'mac', name: 'Mac', os: 'macos', online: true },
  target: { id, name: names[id]!, os: id === 'pc' ? 'windows' : 'linux', online: id !== 'offline' },
  repos: [{ path: 'web', branch: 'main' }, { path: 'api', branch: 'main' }],
  members: [{ path: 'web', target_path: 'frontend', present: true }, { path: 'api', target_path: 'api', present: false }],
  suggested_path: id === 'pc' ? 'D:\\code\\launch' : '/home/dev/launch', target_home: id === 'pc' ? 'D:\\Users\\dev' : '/home/dev',
  path_check: { state: id === 'offline' ? 'unknown' : 'same_repo', path: asked ?? (id === 'pc' ? 'D:\\code\\launch' : '/home/dev/launch'), message: id === 'offline' ? 'Folder checked when the machine returns' : 'Has 1 of 2 repos · only the missing repo will be added' },
  env_files: [{ path: 'api/.env.local', size: 412, selected: true }],
})
const fake = {
  onNotification: (_name: string, fn: (params: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  call: async (method: string, params: Record<string, unknown>) => {
    if (method === 'projects.provision_plan') return plan(String(params.machine), params.path as string | undefined)
    if (method === 'projects.provision.status') return operations.get(String(params.operation_id))
    if (method === 'projects.provision') {
      evidence.requests.push(params); save()
      const target = String(params.machine), id = String(params.operation_id)
      const count = (tries.get(target) ?? 0) + 1; tries.set(target, count)
      const status: ProvisionStatus = { operation_id: id, item_id: id, project_id: 'source', project_name: 'Launch workspace', target, target_name: names[target]!, path: params.path as string, phase: target === 'offline' ? 'queued' : 'sending', bytes_sent: 5, bytes_total: 10, updated_at: new Date().toISOString() }
      operations.set(id, status)
      if (target !== 'offline') setTimeout(() => {
        const next: ProvisionStatus = { ...status, phase: target === 'vps' && count === 1 ? 'failed' : 'done', error: target === 'vps' && count === 1 ? 'Could not reach Build server. Reconnect and retry.' : null }
        operations.set(id, next); for (const fn of listeners) fn(next)
      }, target === 'pc' ? 0 : 180)
      // The selected target can finish before another machine's enqueue response returns.
      if (target === 'vps' && count === 1) await new Promise((resolve) => setTimeout(resolve, 1500))
      return status
    }
    if (method === 'projects.browse') return { path: '/home/dev', parent: '/', directories: [{ name: 'projects', path: '/home/dev/projects' }], has_more: false }
    throw new Error(`Unexpected fixture RPC: ${method}`)
  },
} as unknown as KybernClient
setProvisionFixture({ client: () => fake, context: { name: 'Launch workspace', source: 'mac', instances: [{ machineId: 'mac', machineName: 'Mac', projectId: 'source', online: true }], targets: [
  ...Object.entries(names).map(([machineId, machineName]) => ({ machineId, machineName, online: machineId !== 'offline', has: false })),
  { machineId: 'complete', machineName: 'Already complete', online: true, has: true },
] } })
function Fixture() {
  const t = useTheme()
  const [open, setOpen] = useState(false), [inline, setInline] = useState(false), [draft, setDraft] = useState(evidence.draft), [selected, setSelected] = useState('Mac')
  const close = () => { setOpen(false); evidence.closed++; save() }
  return <div testId="setup-fixture" style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', height: '100%', padding: 16, backgroundColor: t.surface }}>
    <div style={{ display: 'flex', gap: 8 }}>
      <Button testId="open-setup" onClick={() => { setInline(false); setOpen(true) }}>Set up machine</Button>
      <Button testId="open-inline" onClick={() => { setInline(true); setOpen(true) }}>Show setup inline</Button>
      <MachinePicker target={{ show: true, key: 'group:web+api', projectId: 'source', remote: false, reachable: true,
        chosen: { machineId: 'mac', name: 'Mac', isLocal: true, state: 'online', selectable: true, projectId: 'source', detail: 'Online' },
        choices: [{ machineId: 'mac', name: 'Mac', isLocal: true, state: 'online', selectable: true, projectId: 'source', detail: 'Online' }, { machineId: 'pc', name: 'Windows PC', isLocal: false, state: 'no-checkout', selectable: false, detail: 'Missing repositories · add to this machine…' }] }} />
    </div>
    {!open && <TextField testId="fixture-draft" label="Draft" value={draft} onChange={(next) => { setDraft(next); evidence.draft = next; save() }} />}
    <div testId="fixture-selected"><Label color={t.text}>{`Selected: ${selected}`}</Label></div>
    {open && <MachineSetupSheet inline={inline} projectId="source" targetId="pc" close={close} onProvisioned={(plan) => { evidence.mappings.push(plan.target.id); save() }} onReady={async (plan) => { if (plan?.members?.[0]?.target_path !== 'frontend') throw new Error('Group member mapping lost'); evidence.selected = 'Windows PC'; evidence.selections++; save(); setSelected('Windows PC') }} />}
  </div>
}
save()
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Machine setup fixture', width: Number(process.env.SETUP_WIDTH ?? 860), height: 920, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
