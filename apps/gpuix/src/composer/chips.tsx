// Composer chip triggers. Hover and press change colour instantly, like the
// desktop's `chrome` buttons; GPUI's `hover` style cannot recolour children, so
// the chip tracks the pointer itself and hands the colour to its contents.
import { useState, type ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { SCALE } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { Label, useTheme } from '../ui.tsx'

/**
 * Footer picker trigger (`COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME` on a
 * `chrome` button): 28px tall, 10px radius, 10px sides, 6px gap, secondary ink
 * that turns foreground over a faint fill on hover. An accent trigger (auto,
 * Full access) keeps its colour and dims to 85% instead.
 */
export function FooterChip({
  children,
  pressed,
  color,
  dimHover,
  paddingX = 10,
  square,
  disabled,
  testId,
  onClick,
}: {
  children: (color: string) => ReactNode
  pressed?: boolean
  color?: string
  dimHover?: boolean
  paddingX?: number
  square?: boolean
  disabled?: boolean
  testId?: string
  onClick?: () => void
}) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const lit = (hover || pressed) && !disabled
  const ink = color ?? (lit ? t.text : t.textSecondary)
  return (
    <div
      testId={testId}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: square ? 'center' : 'flex-start',
        gap: 6,
        height: 28,
        minWidth: 0,
        flexShrink: square ? 0 : 1,
        ...(square ? { width: 28 } : { paddingLeft: paddingX, paddingRight: paddingX }),
        borderRadius: 10,
        cursor: disabled ? 'default' : 'pointer',
        opacity: dimHover && lit ? 0.85 : 1,
        ...(lit && !dimHover ? { backgroundColor: t.v('--color-background-elevated-secondary') } : {}),
      }}
    >
      {children(ink)}
    </div>
  )
}

/**
 * Tray chip (`COMPOSER_TRAY_CHIP_CLASS_NAME`): a capsule with a 14px icon, 13px
 * label and 12px chevron at 60%, 8×4 padding, button-secondary fill on hover,
 * capped at 16rem so long branch names truncate.
 */
export function TrayChip({
  icon,
  label,
  strong,
  pressed,
  chevron = true,
  testId,
}: {
  icon: string
  label: string
  /** Foreground ink (a chosen value) instead of the secondary tone. */
  strong?: boolean
  pressed?: boolean
  chevron?: boolean
  testId?: string
}) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const ink = strong || hover || pressed ? t.text : t.textSecondary
  return (
    <div
      testId={testId}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // The home tray's chips squash to 0.96 while held (`Draft.tsx:198`, 80 ms down / 150 ms back); rows and picker triggers never scale.
      paintTransform={pressTransform(true, SCALE.large)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 256,
        minWidth: 0,
        flexShrink: 1,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        borderRadius: 999,
        cursor: 'pointer',
        ...(hover || pressed ? { backgroundColor: t.buttonSecondaryHover } : {}),
      }}
    >
      <Icon source={icon} size={14} color={ink} />
      <Label color={ink} size={13} lineHeight={18} truncate>
        {label}
      </Label>
      {chevron && <Icon name="chevronDown" size={12} color={ink} style={{ opacity: 0.6 }} />}
    </div>
  )
}
