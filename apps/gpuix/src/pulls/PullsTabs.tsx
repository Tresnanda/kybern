// The Pull requests page's two tabs, "Pull requests" and "Actions" (ADE-97), drawn in the list column's 46 px header where
// the page title was. Each tab's own header controls follow them.
import type { ReactNode } from 'react'
import { Tabs } from '../kit/Tabs.tsx'
import { useTheme } from '../ui.tsx'
import { row } from '../usage/controls.tsx'
import { setPullsTab, usePullsTab, type PullsTab } from './actions/store.ts'

const ITEMS = [{ key: 'pulls', label: 'Pull requests', testId: 'pulls-tab-pulls' }, { key: 'actions', label: 'Actions', testId: 'pulls-tab-actions' }]

export function PullsHeader({ children }: { children?: ReactNode }) {
  const t = useTheme()
  const tab = usePullsTab(s => s.tab)
  return <div style={{ ...row, height: 46, flexShrink: 0, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}>
    <div style={{ ...row, height: 38, flexShrink: 1, minWidth: 0 }}>
      <Tabs testId="pulls-tab" minWidth={0} overflow={false} animate={false} underlineGap={9} active={tab} onSelect={key => setPullsTab(key as PullsTab)} items={ITEMS} />
    </div>
    <div style={{ flexGrow: 1 }} />
    {children}
  </div>
}
