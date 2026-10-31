// Native Preview list with deterministic machine services; no daemon or network writes.
import '../native/local-build.ts'
import { mock } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { render } from '@gpuix/react'

if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch-preview-network-')) throw Error('Scratch data required')
const output = process.env.KYBERN_PREVIEW_CHECK_LOG!
const state = await import('../state.ts')
const initialState = state.getState()
const machines = await import('../machines/index.ts')
const environment = await import('../shell/environment.ts')
const primary = { id: 'fixture-primary', local: true, name: 'Studio Mac', dataDir: process.env.KYBERN_DATA_DIR! }
mock.module('../shell/environment.ts', () => ({ ...environment, activeEnvironment: () => primary, environmentKey: () => primary.id }))
const rows = [
  { machineId: 'a', name: 'Studio Mac', isLocal: true, offline: false },
  { machineId: 'b', name: 'Build Linux', isLocal: false, offline: false },
  { machineId: 'c', name: 'Windows PC', isLocal: false, offline: false },
  { machineId: 'd', name: 'Travel laptop', isLocal: false, offline: true },
]
const servers: Record<string, object[]> = {
  a: [{ port: 5173, host: 'localhost', url: 'http://localhost:5173', title: 'Other application', cwd: '/elsewhere', process_name: 'bun' }],
  b: [{ port: 3000, host: 'localhost', url: 'http://localhost:3000', title: 'Project docs', cwd: '/work/project/docs', process_name: 'node' }],
  c: [{ port: 5173, host: 'localhost', url: 'http://localhost:5173/app', title: 'Project frontend', cwd: 'C:\\Work\\project\\web', process_name: 'node' }],
}
const record = (machine: string, method: string, params: unknown) => appendFileSync(output, JSON.stringify({ machine, method, params }) + '\n')
const call = async (machine: string, method: string, params: any) => {
  record(machine, method, params)
  if (method === 'previews.servers.list') return { servers: servers[machine] ?? [] }
  if (method === 'ports.list') return { forwards: [] }
  if (method === 'ports.forward') {
    if (params.machine === 'd') throw Error('Travel laptop is offline. Retry when it reconnects.')
    return { local_port: 41001 }
  }
  if (method === 'previews.probe') return { reachable: true, title: 'Project frontend' }
  if (method === 'previews.server.open') return { target: { kind: 'server', url: params.url, port: 41001 } }
  if (method === 'previews.close') return {}
  throw Error(`Unexpected fixture request: ${method}`)
}
const client = (machine: string) => ({
  info: { machine_id: machine, environment_id: machine, hostname: rows.find(r => r.machineId === machine)!.name },
  endpoint: { url: 'ws://127.0.0.1:9/ws' },
  call: (method: string, params: unknown) => call(machine, method, params),
  callRaw: (method: string, params: unknown) => call(machine, method, params),
  onNotification: () => () => {},
})
const project = { id: 'project-b', name: 'Project', path: '/work/project', repo: { root_commit: 'shared-root' } }
const instances = [
  { machineId: 'b', project, offline: false },
  { machineId: 'c', project: { ...project, id: 'project-c', path: 'C:\\Work\\project' }, offline: false },
]
const view = { projects: [{ key: 'root:shared-root', name: 'Project', spaceId: null, colorSeed: 'shared-root', instances, primary: instances[0]! }], machines: rows }
mock.module('../machines/index.ts', () => ({ ...machines, useMachines: () => rows, useMachineView: () => view, clientFor: client }))
const thread = { id: 'preview-thread', project_id: project.id, cwd: project.path }
mock.module('../state.ts', () => ({ ...state, localClient: () => client('a'), threadClient: () => client('b'), machineOfThreadId: () => 'b', getState: () => ({ ...initialState, threads: [thread], projects: [project] }) }))
const { PreviewPane } = await import('./Preview.tsx')
const { recordRecent, recentsKeyForThread } = await import('./recents.ts')
const { ThemeProvider, useTheme } = await import('../ui.tsx')
const { onWindowKeyDown } = await import('../nav/keys.ts')
recordRecent(recentsKeyForThread(thread.id), { kind: 'server', value: 'http://localhost:5173/app', title: 'Travel project', at: Date.now(), machine: { id: 'd', name: 'Travel laptop', port: 5173, path: '/app' } })
function Fixture() {
  const t = useTheme()
  return <div testId="preview-network-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><PreviewPane threadId={thread.id} /></div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Network Preview verification', width: 900, height: 700, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
