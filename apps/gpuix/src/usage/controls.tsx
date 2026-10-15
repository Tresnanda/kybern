import { motion, type StyleDesc } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { setNav } from '../nav/store.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'

export const row: StyleDesc = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
export const column: StyleDesc = { display: 'flex', flexDirection: 'column', minWidth: 0 }

export function Button({ children, onClick, testId, disabled, primary, style }: { children: ReactNode; onClick?: () => void; testId?: string; disabled?: boolean; primary?: boolean; style?: StyleDesc }) {
  const t = useTheme()
  const run = () => { if (!disabled) onClick?.() }
  return <div testId={testId} role="button" aria-label={typeof children === 'string' ? children : undefined} tabIndex={disabled ? -1 : 0} onClick={run} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { setNav({ keyboardNav: true }); run() } }} style={{ ...row, justifyContent: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 8, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1, backgroundColor: primary ? t.buttonPrimary : 'transparent', hover: { backgroundColor: disabled ? 'transparent' : primary ? t.buttonPrimary : t.buttonTertiaryHover }, active: { backgroundColor: t.buttonSecondaryHover }, ...style }}><Label color={primary ? t.buttonPrimaryText : t.text} size={12}>{children}</Label></div>
}

/** Fixed-width segments let the native pill move without a measurement loop. */
export function Segments<T extends string>({ value, options, onChange, testId, width = 72, plain = false }: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; testId: string; width?: number; plain?: boolean }) {
  const t = useTheme()
  const [instant, setInstant] = useState(true)
  const index = options.findIndex(([key]) => key === value)
  return <div role="tablist" aria-label={testId} style={{ ...row, gap: 0, position: 'relative', padding: 3, height: 34, borderRadius: 8, backgroundColor: plain ? 'transparent' : t.buttonSecondary }}>
    <motion.div initial={false} animate={{ left: 3 + Math.max(0, index) * width }} transition={{ duration: REDUCED_MOTION || instant ? 0 : .2, ease: EASE_OUT }} style={{ position: 'absolute', top: 3, width, height: 28, borderRadius: 5, backgroundColor: plain ? t.buttonSecondary : t.surface }} />
    {options.map(([key, label], i) => <div key={key} testId={`${testId}-${key}`} role="tab" aria-selected={key === value} tabIndex={0} onClick={() => { setInstant(false); onChange(key) }} onKeyDown={e => {
      const next = e.key === 'right' ? (i + 1) % options.length : e.key === 'left' ? (i + options.length - 1) % options.length : e.key === 'enter' || e.key === 'space' ? i : -1
      if (next >= 0) { setInstant(true); onChange(options[next]![0]) }
    }} style={{ ...row, width, height: 28, justifyContent: 'center', cursor: 'pointer' }}><Label color={key === value ? t.text : t.textSecondary} size={12}>{label}</Label></div>)}
  </div>
}

export function Header({ title, children }: { title: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ ...row, height: 46, flexShrink: 0, paddingLeft: 20, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}><Label color={t.text} size={14} weight={500} style={{ flexGrow: 1 }}>{title}</Label>{children}</div>
}
