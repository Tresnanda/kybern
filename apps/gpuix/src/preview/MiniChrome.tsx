import type { ReactNode } from 'react'
import { motion } from '@gpuix/react'
import { BACKDROP } from '../native/backdrop.ts'
import { BACKDROP_ALLOWED, backdropTint } from '../native/backdrop-material.ts'
import { useWebOcclusion } from '../native/web-occlusion.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
/**
 * kit.css `.preview-pip__header`: hidden until the player is hovered or focused, then fades in over 150ms
 * (ease-out, rising 2px; reduced motion fades linearly without the rise). Mounted only while shown so an
 * idle player holds neither the blur layer nor an occlusion cut in the page.
 */
export function MiniChrome({ title, otherThread, revealed, children }: { title: string; otherThread?: string; revealed: boolean; children: ReactNode }) {
  const t = useTheme(), layer = useWebOcclusion('preview-mini-header')
  return <motion.div testId={layer.id} initial={{ opacity: 0, translateY: REDUCED_MOTION ? 0 : -2 }} animate={{ opacity: revealed ? 1 : 0, translateY: revealed || REDUCED_MOTION ? 0 : -2 }} transition={{ duration: 0.15, ease: REDUCED_MOTION ? 'linear' : EASE_OUT }} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 28, pointerEvents: revealed ? 'auto' : 'none' }}>
    <div backdrop={BACKDROP_ALLOWED ? BACKDROP.previewHeader : undefined} style={{ width: '100%', height: 28, display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 10, paddingRight: 4, borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: BACKDROP_ALLOWED ? backdropTint(t.popover) : t.popover }}>
      <Label color={t.text} size={12} lineHeight={16} truncate style={{ flexGrow: 1, opacity: 0.9 }}>{title}</Label>
      {otherThread && <Label color={t.textSecondary} size={11} lineHeight={16} truncate style={{ maxWidth: '40%', flexShrink: 1 }}>{otherThread}</Label>}
      {children}
    </div>
  </motion.div>
}
