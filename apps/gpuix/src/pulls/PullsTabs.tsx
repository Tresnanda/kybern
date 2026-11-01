// The Pull requests page's two tabs, "Pull requests" and "Actions" (ADE-97), drawn in the list column's 46 px header where
// the page title was. Each tab's own header controls follow them.
import { Folder01Icon } from '@hugeicons/core-free-icons'
import type { ReactNode } from 'react'
import { glyph } from '../icons.tsx'
import { Tabs } from '../kit/Tabs.tsx'
import { useTheme } from '../ui.tsx'
import { row } from '../usage/controls.tsx'
import { setPullsTab, usePullsTab, type PullsTab } from './actions/store.ts'

/** List-column widths below which a header picker shows a folder glyph instead of its name: the tabs, the picker at a
 *  readable width and the header's icon buttons don't fit together (one button on Pull requests, two on Actions). */
export const HEADER_COMPACT_PULLS = 336
export const HEADER_COMPACT_ACTIONS = 352
/** The compact picker's glyph: the kit's folder at the standard icon stroke, matching the header's other icon buttons. */
export const FOLDER = glyph(Folder01Icon)

const ITEMS = [{ key: 'pulls', label: 'Pull requests', testId: 'pulls-tab-pulls' }, { key: 'actions', label: 'Actions', testId: 'pulls-tab-actions' }]

export function PullsHeader({ children }: { children?: ReactNode }) {
  const t = useTheme()
  const tab = usePullsTab(s => s.tab)
  return <div style={{ ...row, height: 46, flexShrink: 0, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}>
    {/* The tabs keep their width; the controls after them truncate first (a narrow column overlapped "Actions"). */}
    <div style={{ ...row, height: 38, flexShrink: 0 }}>
      <Tabs testId="pulls-tab" minWidth={0} overflow={false} animate={false} underlineGap={9} active={tab} onSelect={key => setPullsTab(key as PullsTab)} items={ITEMS} />
    </div>
    <div style={{ flexGrow: 1, minWidth: 6 }} />
    {children && <div style={{ ...row, flexShrink: 1, minWidth: 0 }}>{children}</div>}
  </div>
}
