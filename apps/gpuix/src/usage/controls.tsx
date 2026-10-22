import type { StyleDesc } from '@gpuix/react'
import type { ReactNode } from 'react'

import { Label, useTheme } from '../ui.tsx'

export const row: StyleDesc = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
export const column: StyleDesc = { display: 'flex', flexDirection: 'column', minWidth: 0 }

export function Header({ title, children }: { title: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ ...row, height: 46, flexShrink: 0, paddingLeft: 20, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}><Label color={t.text} size={14} weight={500} style={{ flexGrow: 1 }}>{title}</Label>{children}</div>
}
