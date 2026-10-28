// The inspector layout of a side panel (the pull request sidebar; the same 76 px label column as `tasks/TaskDetail.tsx`):
// `InspectorGroup` is a block with a hairline above it (except the first), `InspectorRow` a label and its value(s), and
// `SectionHeader` a group's title with a trailing summary.
import type { ReactNode } from 'react'
import { Label, useTheme } from '../ui.tsx'

export function InspectorGroup({ children, first = false, testId }: { children: ReactNode; first?: boolean; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingTop: 10, paddingBottom: 10, ...(first ? {} : { borderTopWidth: 1, borderColor: t.surfaceDivider }) }}>{children}</div>
}

export function SectionHeader({ title, trailing }: { title: string; trailing?: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, minWidth: 0 }}><Label color={t.textSecondary} size={12} lineHeight={16} weight={500}>{title}</Label><div style={{ flexGrow: 1 }} />{trailing && <Label color={t.textTertiary} size={12} lineHeight={16} truncate>{trailing}</Label>}</div>
}

export function InspectorRow({ label, children, testId, onClick }: { label: string; children: ReactNode; testId?: string; onClick?: () => void }) {
  const t = useTheme()
  return (
    <div testId={testId} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? e => { if (e.key === 'enter' || e.key === 'space') onClick() } : undefined} style={{ display: 'flex', alignItems: 'flex-start', minHeight: 32, paddingTop: 5, paddingBottom: 5, minWidth: 0, ...(onClick ? { cursor: 'pointer' } : {}) }}>
      <div style={{ width: 76, flexShrink: 0, paddingTop: 2 }}><Label color={t.textSecondary} size={12} lineHeight={18}>{label}</Label></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0, flexGrow: 1, flexShrink: 1, minHeight: 22 }}>{children}</div>
    </div>
  )
}
