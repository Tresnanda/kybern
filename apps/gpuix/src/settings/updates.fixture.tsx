import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { UpdatesSection } from './Updates.tsx'
import { beginUpdate, reconcileUpdates, updateRunSummary } from '../../../../packages/kybern-client/src/updateRun.ts'
import type { MachineCard } from '../../../../packages/kybern-client/src/types.ts'
const names = ['SatyaMas', 'instabox-anjay', 'Treshnandas-Macbook', 'kdi-vps']
const machines = names.map((name, i) => ({ machine_id: String(i), name, version: '0.22.1', status: 'online', features: ['update.progress.v1'] })) as MachineCard[]
function Fixture() {
 const t = useTheme()
 const [done, setDone] = useState(process.env.UPDATE_SHOT === 'done')
 const states = ['updating', 'waiting', 'restarting', 'current'] as const
 const cards = machines.map((m, i) => ({ ...m, version: done || i === 3 ? '0.23.0' : m.version, update: { update_id: `attempt-${i}`, current_version: done || i === 3 ? '0.23.0' : '0.22.1', target_version: '0.23.0', latest_version: '0.23.0', status: done ? 'current' as const : states[i], message: '', checked_at: null, ...(i === 0 && !done ? { download_percent: 64 } : {}), ...(i === 1 && !done ? { busy_thread: 'Review network changes' } : {}) } }))
 const run = reconcileUpdates(beginUpdate(machines), cards)
 return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface, paddingTop: 24 }}>
  <UpdatesSection rows={Object.values(run)} summary={updateRunSummary(run)} busy={false} following={true} followBusy={false} onUpdate={() => setDone(false)} onRetry={() => {}} onFollow={() => setDone(true)} />
 </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Machine updates', width: 820, height: 570, focus: false })
process.stdin.on('end', () => process.exit(0))
