import { motion } from '@gpuix/react'
import type { ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { EASE_OUT, ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { muted } from '../nav/overlay.tsx'
import { Rise } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'

/**
 * A dock panel's empty state. Like the kit's `Empty` it runs `.t-stagger` on mount: the icon, the title and the description rise
 * 12 px into place from a 3 px blur, 70 ms apart (`Rise kind="stagger"`, paint-only). Reduce Motion: no entrance, as the desktop.
 */
export function DockEmpty({ icon, title, body, lineage = false }: { icon: string; title: string; body?: string; lineage?: boolean }) {
  const t = useTheme()
  const play = !REDUCED_MOTION
  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: lineage ? 12 : 8, paddingLeft: 32, paddingRight: 32, paddingTop: lineage ? 0 : 32, paddingBottom: lineage ? 40 : 32 }}>
    <Rise kind="stagger" index={0} play={play} style={{ alignItems: 'center' }}><Icon source={icon} size={20} color={lineage ? ink(t, 0.35) : muted(t, 0.5)} /></Rise>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: lineage ? 4 : 8, maxWidth: 256 }}>
      <Rise kind="stagger" index={1} play={play} style={{ alignItems: 'center' }}><Label color={lineage ? ink(t, 0.85) : t.text} size={13} weight={500}>{title}</Label></Rise>
      {body && <Rise kind="stagger" index={2} play={play} style={{ alignItems: 'center' }}><Label color={lineage ? ink(t, 0.55) : muted(t, 0.65)} size={12} lineHeight={20} style={{ maxWidth: 256, textAlign: 'center' }}>{body}</Label></Rise>}
    </div>
  </div>
}

/** A dock text action: the desktop's kit `Button` (chip/xs/sm) or `press` button, so it squashes on press (`motion/press.ts`).
 *  `press={false}` where the desktop control does not (alert-dialog closes, "Show more" links, toolbar actions). */
export function Action({ children, onClick, disabled, testId, textSize = 11, secondary = false, press = true }: { children: ReactNode; onClick: () => void; disabled?: boolean; testId?: string; textSize?: number; secondary?: boolean; press?: boolean }) {
  const t = useTheme()
  return <div role="button" tabIndex={disabled ? -1 : 0} onKeyDown={(event) => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onClick() }} aria-disabled={disabled} testId={testId} onClick={disabled ? undefined : onClick} paintTransform={pressTransform(press && !disabled)}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: secondary ? t.buttonSecondary : undefined, flexShrink: 0, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer', hover: disabled ? {} : { backgroundColor: t.buttonSecondaryHover } }}>
    <Label color={t.textSecondary} size={textSize}>{children}</Label>
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
      <Label color={t.text} size={14} lineHeight={18.9} weight={500} style={{ whiteSpace: 'normal' }}>{title}</Label>
      <Label color={muted(t, 0.65)} size={13} lineHeight={18.2} style={{ whiteSpace: 'normal' }}>{detail}</Label>
    </div>
    <div style={{ width: 32, height: 20, marginTop: 2, flexShrink: 0, position: 'relative', borderRadius: 10, backgroundColor: checked ? t.switchOn : t.switchOff, borderWidth: 1, borderColor: checked ? t.switchOn : t.switchOffBorder }}>
      {PATCHED_NATIVE
        // The thumb only moves: a paint-only translation (no layout per frame) from its off slot.
        ? <div paintTransform={{ initial: false, animate: { translateX: checked ? 12 : 0 }, transition: { duration: REDUCED_MOTION ? 0 : 0.2, ease: EASE_OUT } }} style={{ position: 'absolute', left: 2, top: 1, width: 16, height: 16, borderRadius: 8, backgroundColor: '#ffffff' }} />
        : <motion.div initial={false} animate={{ left: checked ? 14 : 2 }} transition={{ duration: REDUCED_MOTION ? 0 : 0.2, ease: EASE_OUT }} style={{ position: 'absolute', top: 1, width: 16, height: 16, borderRadius: 8, backgroundColor: '#ffffff' }} />}
    </div>
  </div>
}
