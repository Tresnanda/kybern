// `PreviewCard` (components/kit/preview-card.tsx): a hover-opened, interactive card. Unlike a tooltip
// it stays open while the pointer is on the card, so it can hold controls. One card is visible
// app-wide (`hoverController.ts`); a card opened right after another closed (`skip`) appears without motion.
import type { StyleDesc } from '@gpuix/react'
import { useRef, type ReactElement, type ReactNode } from 'react'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { useTheme } from '../ui.tsx'
import { hoverTrigger, HoverScopeProvider, useHover } from './hover.tsx'
import { CARD_CLOSE_DELAY_MS, CARD_DELAY_MS } from './hoverController.ts'

export function HoverCard({
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  sideOffset = 8,
  delay = CARD_DELAY_MS,
  closeDelay = CARD_CLOSE_DELAY_MS,
  skip = 0,
  width,
  style,
  rootStyle,
  testId,
  disabled,
}: {
  /** One host element (a `div`) that takes the hover, press and focus handlers. */
  trigger: ReactElement
  /** The card body. */
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** `PreviewCardPopup` default 8. */
  sideOffset?: number
  /** `PreviewCard` Trigger `delay` (default 600). */
  delay?: number
  /** `closeDelay` (default 300). */
  closeDelay?: number
  /** A card opening within this many ms of another hover popup closing opens at once, without motion. */
  skip?: number
  width?: number
  /** Overrides on the card surface (radius, padding, fill). */
  style?: StyleDesc
  /** Overrides on the wrapper that holds the trigger. */
  rootStyle?: StyleDesc
  testId?: string
  disabled?: boolean
}) {
  const t = useTheme()
  const { ctl, state } = useHover({ delay, closeDelay, skip, hoverable: true })
  const pressed = useRef(false)
  if (disabled) return trigger
  return (
    <div style={{ display: 'flex', position: 'relative', alignItems: 'start', minWidth: 0, ...rootStyle }}>
      {hoverTrigger(ctl, true, trigger, pressed, false)}
      {state.active !== null && (
        <PopupLayer
          testId={testId}
          still={state.instant}
          side={side}
          align={align}
          sideOffset={sideOffset}
          onMouseEnter={() => ctl.popupEnter()}
          onMouseLeave={() => ctl.popupLeave()}
          style={{ ...popoverStyle(t), display: 'flex', flexDirection: 'column', ...(width ? { width } : {}), ...style }}
        >
          <HoverScopeProvider ctl={ctl as never}>{children}</HoverScopeProvider>
        </PopupLayer>
      )}
    </div>
  )
}
