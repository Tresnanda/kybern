// The desktop's `Badge` (`components/kit/badge.tsx`): a small label chip. Sizes sm 16 / default 18 / lg 22 px tall
// (`sm:` values), square minimum, radius 4 (sm) or 6, a 1px transparent border (the outline variant's is
// `--color-border`), medium text at `--app-font-size-ui-2xs` / `-xs` / `-sm` with a 1.5 line height, 12 px glyphs
// at 80%, 4 px gaps. Tinted variants (error, info, success, warning) fill their colour at 8% (16% in dark).
// With `onClick` it is a button (`[button&]`): pointer cursor and the variant's `/90` hover fill.
import type { StyleDesc } from '@gpuix/react'
import { useState } from 'react'
import { getAppTypographyScale } from '@/lib/kit/appTypography'
import { Label, useTheme } from '../ui.tsx'
import { popAnimation, useCountPop } from './Pop.tsx'
import { withAlpha } from './Switch.tsx'

const TYPE = getAppTypographyScale()
export const BADGE_SIZE = {
  sm: { height: 16, padX: 3, radius: 4, text: TYPE.ui2XsPx },
  default: { height: 18, padX: 3, radius: 6, text: TYPE.uiXsPx },
  lg: { height: 22, padX: 5, radius: 6, text: TYPE.uiSmPx },
} as const
/** A count the badge pops when it changes (`t-pop` + `key={count}`): digits with an optional sign or k/m suffix. */
const COUNT = /^[+\-−]?\d[\d.,]*[kKmM]?$/
export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'error' | 'info' | 'success' | 'warning'

export function Badge({ children, variant = 'default', size = 'default', icon, onClick, testId, style }: { children?: string; variant?: BadgeVariant; size?: keyof typeof BADGE_SIZE; /** Leading glyph source (`N.*`). */ icon?: string; onClick?: () => void; testId?: string; style?: StyleDesc }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const g = BADGE_SIZE[size]
  // Constant on the first render and while the text holds, so only a change after mount pops (not an initial or recycled row).
  const pops = useCountPop(children ?? '')
  const countPop = children != null && COUNT.test(children) && pops > 0
  const tint = (token: string) => withAlpha(t.v(token), t.variant === 'dark' ? 0.16 : 0.08)
  const look: Record<BadgeVariant, { bg: string; fg: string; hover?: string; border?: string }> = {
    default: { bg: t.v('--primary'), fg: t.v('--primary-foreground'), hover: withAlpha(t.v('--primary'), 0.9) },
    destructive: { bg: t.v('--destructive'), fg: '#ffffff', hover: withAlpha(t.v('--destructive'), 0.9) },
    error: { bg: tint('--destructive'), fg: t.v('--destructive') },
    info: { bg: tint('--info'), fg: t.v('--info-foreground') },
    outline: { bg: t.v('--color-background-elevated-primary-opaque'), fg: t.v('--color-text-foreground'), hover: t.v('--color-background-button-secondary-hover'), border: t.v('--color-border') },
    secondary: { bg: t.v('--secondary'), fg: t.v('--secondary-foreground'), hover: withAlpha(t.v('--secondary'), 0.9) },
    success: { bg: tint('--success'), fg: t.v('--success') },
    warning: { bg: tint('--warning'), fg: t.v('--warning') },
  }
  const l = look[variant]
  const bg = onClick && hover && l.hover ? l.hover : l.bg
  return (
    <div
      testId={testId}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'enter' || e.key === 'space') onClick() } : undefined}
      onMouseEnter={onClick ? () => setHover(true) : undefined}
      onMouseLeave={onClick ? () => setHover(false) : undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, height: g.height, minWidth: g.height,
        paddingLeft: g.padX, paddingRight: g.padX, borderRadius: g.radius, borderWidth: 1, borderColor: l.border ?? 'rgba(0, 0, 0, 0)',
        backgroundColor: bg, cursor: onClick ? 'pointer' : undefined, ...style,
      }}
    >
      {icon && <svg source={icon} style={{ width: 12, height: 12, flexShrink: 0, color: l.fg, opacity: 0.8, pointerEvents: 'none' }} />}
      {children != null && <Label key={countPop ? pops : 'text'} paintAnimation={countPop ? popAnimation() : undefined} color={l.fg} size={g.text} lineHeight={g.text * 1.5} weight={500} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>{children}</Label>}
    </div>
  )
}
