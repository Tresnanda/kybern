// Dialog primitives for the environment flows, mirroring `components/kit/dialog`,
// `button`, `input` and `views/environmentStyles.ts` (measured in the desktop
// frontend: header 16/16/4, title 15/18.75, description 14/22.75, panel gap 16,
// field label 13/19.5 w500, hint 13/21.125, buttons h32 radius 10, disabled 64%).
// Buttons, icon buttons and fields are the control-system kit components (`kit/Button`, `IconButton`, `Field`).
import { useWindowSize } from '@gpuix/react'
import type { ReactNode } from 'react'

import { IconButton } from '../kit/IconButton.tsx'


import { N } from '../nav/glyphs.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { Chevron } from '../motion/Chevron.tsx'

const TRIANGLE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M1.6 0.4 9.2 5 1.6 9.6Z" fill="#000"/></svg>'

/** `DialogHeader` + `DialogTitle` + `DialogDescription` with the environment overrides. */
export function DialogHeader({ title, description, onClose }: { title: string; description: string; onClose: () => void }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 40, paddingTop: 16, paddingBottom: 4, position: 'relative' }}>
    <Label color={t.text} size={15} lineHeight={18.75} weight={600}>{title}</Label>
    <Label color={t.textSecondary} size={14} lineHeight={22.75}>{description}</Label>
    <IconButton testId="dialog-close" label="Close" icon={N.x} onClick={onClose} style={{ position: 'absolute', top: 8, right: 8 }} />
  </div>
}

/** `DialogPanel`: a scrolling column that starts flush under the header (the desktop's `pt-0`). */
export function DialogBody({ children, footer = false, testId, scroll = false }: { children: ReactNode; footer?: boolean; testId?: string; scroll?: boolean }) {
  const size = useWindowSize({ intervalMs: 250 })
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 16, paddingRight: 16, paddingBottom: footer ? 12 : 16, ...(scroll ? { maxHeight: size.height - 100, minHeight: 0, flexShrink: 1, overflowY: 'scroll' } : {}) }}>{children}</div>
}

/** `DialogFooter`: right-aligned actions, 12px above and below. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>{children}</div>
}

/** `dialogFieldLabelClassName` over an input: 13px medium at 80% foreground, 6px gap. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Label color={ink(t, .8)} size={13} lineHeight={19.5} weight={500}>{label}</Label>{children}</div>
}

/** `ENVIRONMENT_HINT`. */
export function Hint({ children, center = false, color }: { children: ReactNode; center?: boolean; color?: string }) {
  const t = useTheme()
  return <Label color={color ?? t.textSecondary} size={13} lineHeight={21.125} style={center ? { textAlign: 'center' } : undefined}>{children}</Label>
}

/** `ENVIRONMENT_ERROR`: destructive text for `role="alert"` lines. */
export function ErrorText({ children, testId }: { children: ReactNode; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} role="alert"><Label color={t.red} size={13} lineHeight={21.125}>{children}</Label></div>
}

/** The `<details>` summary the desktop shows: a small solid triangle that turns down when open (220 ms, the disclosure curve). */
export function Disclosure({ label, open, toggle, testId }: { label: string; open: boolean; toggle: () => void; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }} style={{ display: 'flex', alignItems: 'center', alignSelf: 'flex-start', gap: 5, paddingTop: 4, paddingBottom: 4, cursor: 'pointer' }}>
    <Chevron source={TRIANGLE} size={11} color={t.textSecondary} open={open} />
    <Hint>{label}</Hint>
  </div>
}
