import type { ReactNode } from 'react'
import { BACKDROP } from '../native/backdrop.ts'
import { BACKDROP_ALLOWED, backdropTint } from '../native/backdrop-material.ts'
import { useWebOcclusion } from '../native/web-occlusion.ts'
import { Label, useTheme } from '../ui.tsx'
export function MiniChrome({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme(), layer = useWebOcclusion('preview-mini-header')
  return <div testId={layer.id} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 28 }}><div backdrop={BACKDROP_ALLOWED ? BACKDROP.previewHeader : undefined} style={{ width: '100%', height: 28, display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 10, paddingRight: 4, borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: BACKDROP_ALLOWED ? backdropTint(t.popover) : t.popover }}><Label color={t.text} size={12} lineHeight={16} truncate style={{ flexGrow: 1 }}>{title}</Label>{children}</div></div>
}
