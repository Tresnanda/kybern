import { motion } from '@gpuix/react'
import type { ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { muted } from '../nav/overlay.tsx'

export function DockEmpty({ icon, title, body }: { icon: string; title: string; body?: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 }}>
    <Icon source={icon} size={20} color={muted(t, 0.5)} />
    <Label color={t.text} size={13} weight={500}>{title}</Label>
    {body && <Label color={muted(t, 0.65)} size={12} lineHeight={20} style={{ maxWidth: 256, textAlign: 'center' }}>{body}</Label>}
  </div>
}

export function Action({ children, onClick, disabled, testId }: { children: ReactNode; onClick: () => void; disabled?: boolean; testId?: string }) {
  const t = useTheme()
  return <div role="button" tabIndex={disabled ? -1 : 0} onKeyDown={(event) => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onClick() }} aria-disabled={disabled} testId={testId} onClick={disabled ? undefined : onClick}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 6, flexShrink: 0, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer', hover: disabled ? {} : { backgroundColor: t.buttonSecondaryHover } }}>
    <Label color={t.textSecondary} size={11}>{children}</Label>
  </div>
}

export function Section({ label, children }: { label: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', height: 32, flexShrink: 0, alignItems: 'center', gap: 6, paddingLeft: 14, paddingRight: 6 }}>
    <Label color={muted(t, 0.6)} size={11} style={{ flexGrow: 1 }}>{label}</Label>{children}
  </div>
}

export function ErrorLine({ error, retry }: { error: string | null; retry?: () => void }) {
  const t = useTheme()
  if (!error) return null
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 12 }}>
    <Label color={t.red} size={12}>{error}</Label>
    {retry && <Action onClick={retry}>Try again</Action>}
  </div>
}

/** Desktop Switch: 32 × 20 track, 16px thumb; a 28px pointer/keyboard target. */
export function SwitchRow({ title, detail, checked, disabled, onChange, testId }: { title: string; detail: string; checked: boolean; disabled?: boolean; onChange: () => void; testId?: string }) {
  const t = useTheme()
  const activate = () => { if (!disabled) onChange() }
  return <div role="switch" aria-label={title} aria-valuetext={checked ? 'On' : 'Off'} tabIndex={disabled ? -1 : 0} testId={testId} onClick={activate}
    onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') activate() }}
    style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 28, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.64 : 1 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
      <Label color={t.text} size={12} lineHeight={16} weight={500} style={{ whiteSpace: 'normal' }}>{title}</Label>
      <Label color={muted(t, 0.65)} size={11} lineHeight={16} style={{ whiteSpace: 'normal' }}>{detail}</Label>
    </div>
    <div style={{ width: 32, height: 20, marginTop: 2, flexShrink: 0, position: 'relative', borderRadius: 10, backgroundColor: checked ? t.link : t.buttonSecondaryHover, borderWidth: 1, borderColor: checked ? t.link : t.border }}>
      <motion.div initial={false} animate={{ left: checked ? 14 : 2 }} transition={{ duration: REDUCED_MOTION ? 0 : 0.2, ease: EASE_OUT }} style={{ position: 'absolute', top: 1, width: 16, height: 16, borderRadius: 8, backgroundColor: '#ffffff' }} />
    </div>
  </div>
}
