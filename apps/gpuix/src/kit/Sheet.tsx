// `components/kit/sheet.tsx` on GPUIX: a panel docked to one window edge over a `bg-black/60` scrim.
//
// Geometry (measured in the desktop gallery): right/left sheets are `w-[calc(100%-3rem)] max-w-md` (448px) and
// full height with a 1px `border-s`/`border-e`; top/bottom sheets span the width with their own height (capped
// 48px short of the window) and a 1px bottom/top border. `bg-popover`, `shadow-lg/5` (two 5% shadows). `inset`
// floats 16px from the edges with radius 18 (`rounded-2xl`) and a full border. Close button: 32px ghost icon at
// 8px from the top-right corner. Header 24/24/12 (gap 8), title 20/20 semibold, description 14/20 muted;
// panel 4/24/24 and scrolls; footer `border-t bg-muted/72` 16/24 with right-aligned buttons (`bare`: no
// border or fill, 12/24/24).
//
// Motion: the scrim fades over 200 ms with Tailwind's default curve; the panel fades and slides 32px from
// its edge over 200 ms `--ease-in-out`, in and out (Base UI keeps it mounted through `data-ending-style`; the
// desktop exit is as long as the enter). Both are paint-only `paintTransform`s (no layout per frame). Reduce Motion keeps
// the fades and drops the slide. Escape and a click on the scrim close it; focus returns to the opener.
import { createContext, useContext, useState, type ReactNode } from 'react'
import { muted } from '../composer/Menu.tsx'
import { useSettingsModal } from '../settings/controls.tsx'
import { Label, useTheme } from '../ui.tsx'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'
import {
  CLOSE_GLYPH, EASE_DEFAULT, EASE_IN_OUT_CSS, ModalLayer, useEscapeLayer, usePresence, useReturnFocus, WindowSized,
  controlVariant,
  type ButtonVariant,
} from './AlertDialog.tsx'
import type { ButtonVariant as ControlVariant } from './Button.tsx'
import { Button } from './Button.tsx'
import { IconButton } from './IconButton.tsx'

export type SheetSide = 'right' | 'left' | 'top' | 'bottom'
const DURATION = 0.2
/** `translate-x-8` / `translate-y-8`. */
const SLIDE = 32

const SheetContext = createContext<{ close: () => void; side: SheetSide; inset: boolean } | null>(null)

/** `Sheet` + `SheetPopup`: controlled (`open`/`onOpenChange`) or uncontrolled (`defaultOpen`). */
export function Sheet({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  side = 'right',
  variant = 'default',
  showCloseButton = true,
  dismissible = true,
  width = 448,
  children,
  testId,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  side?: SheetSide
  variant?: 'default' | 'inset'
  showCloseButton?: boolean
  /** A click on the scrim closes the sheet (Base UI Dialog's outside press). */
  dismissible?: boolean
  /** `max-w-md` for left/right sheets. */
  width?: number
  children: ReactNode
  testId?: string
}) {
  const t = useTheme()
  const g = useGlass()
  const [own, setOwn] = useState(defaultOpen)
  const open = openProp ?? own
  const setOpen = (next: boolean) => { if (openProp === undefined) setOwn(next); onOpenChange?.(next) }
  const presence = usePresence(open, DURATION * 1000)
  const escape = useEscapeLayer(open)
  useSettingsModal(open)
  useReturnFocus(open)
  if (!presence.mounted) return null
  return <WindowSized>{(size) => {
    const inset = variant === 'inset'
    const pad = inset ? 16 : 0
    const vertical = side === 'left' || side === 'right'
    const W = size.width - pad * 2, H = size.height - pad * 2
    const panelWidth = vertical ? Math.min(width, W - 48) : W
    const x = side === 'right' ? size.width - pad - panelWidth : pad
    const y = side === 'bottom' ? size.height - pad : pad
    const offset = side === 'right' ? { left: SLIDE } : side === 'left' ? { left: -SLIDE } : side === 'top' ? { top: -SLIDE } : { top: SLIDE }
    const border = inset
      ? { borderWidth: 1 }
      : side === 'right' ? { borderLeftWidth: 1 } : side === 'left' ? { borderRightWidth: 1 } : side === 'top' ? { borderBottomWidth: 1 } : { borderTopWidth: 1 }
    const radius = inset ? 18 : 0
    return (
      <SheetContext.Provider value={{ close: () => setOpen(false), side, inset }}>
        <ModalLayer
          phase={presence.phase}
          gen={presence.gen}
          duration={DURATION}
          ease={EASE_DEFAULT}
          position={{ x: 0, y: 0 }}
          priority={5}
          testId={testId ? `${testId}-backdrop` : undefined}
          style={{ width: size.width, height: size.height, backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        />
        <ModalLayer
          phase={presence.phase}
          gen={presence.gen}
          onExited={presence.done}
          duration={DURATION}
          ease={EASE_IN_OUT_CSS}
          offset={offset}
          position={{ x, y }}
          anchor={side === 'bottom' ? 'bottomLeft' : 'topLeft'}
          priority={6}
          radius={radius}
          backdrop={frostBackdrop(g, 'menus', radius)}
          testId={testId}
          focus
          onKeyDown={(e) => { if (e.key === 'escape' && escape.claim()) setOpen(false) }}
          // A press in a nested popup (an alert's card, a select hanging past the panel) is not a scrim press.
          onMouseDownOutside={dismissible ? () => { if (escape.isTop()) setOpen(false) } : undefined}
          // `shadow-lg/5`: two 5% layers; the wrapper carries the wider one, the panel the tighter one.
          style={{ display: 'flex', borderRadius: radius, ...(g.on ? {} : { boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 15, spreadRadius: -3, color: 'rgba(0, 0, 0, 0.05)' } }) }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              width: panelWidth,
              ...(vertical ? { height: H } : { maxHeight: H - 48 }),
              backgroundColor: frostFill(g, 'menus', t.v('--popover'), 'frostMenu'),
              borderColor: g.on ? g.frostRim : t.border,
              ...border,
              borderRadius: radius,
              overflow: 'hidden',
              ...(g.on ? {} : { boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 6, spreadRadius: -4, color: 'rgba(0, 0, 0, 0.05)' } }),
            }}
          >
            {children}
            {showCloseButton && (
              <div style={{ position: 'absolute', top: 8, right: 8 }}>
                <IconButton icon={CLOSE_GLYPH} label="Close" size="lg" testId={testId ? `${testId}-close` : undefined} onClick={() => setOpen(false)} />
              </div>
            )}
          </div>
        </ModalLayer>
      </SheetContext.Provider>
    )
  }}</WindowSized>
}

/** `SheetHeader`: 24px padding (12px below when a panel follows), 8px between title and description. */
export function SheetHeader({ children, beforePanel = true }: { children: ReactNode; beforePanel?: boolean }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 24, paddingBottom: beforePanel ? 12 : 24, flexShrink: 0 }}>{children}</div>
}

/** `SheetTitle`: `font-heading font-semibold text-xl leading-none`. */
export function SheetTitle({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={t.text} size={20} lineHeight={20} weight={600}>{children}</Label>
}

/** `SheetDescription`: `text-muted-foreground text-sm`. */
export function SheetDescription({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={muted(t, 1)} size={14} lineHeight={20}>{children}</Label>
}

/** `SheetPanel`: the scrolling body, 24px sides and bottom, 4px under a header. */
export function SheetPanel({ children, afterHeader = true, beforeBareFooter = false, testId }: { children: ReactNode; afterHeader?: boolean; beforeBareFooter?: boolean; testId?: string }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflowY: 'scroll' }}>
      <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 24, paddingRight: 24, paddingTop: afterHeader ? 4 : 24, paddingBottom: beforeBareFooter ? 4 : 24, flexShrink: 0 }}>{children}</div>
    </div>
  )
}

/** `SheetFooter`: `default` has the top border and `bg-muted/72`; `bare` is plain. Buttons sit right, 8px apart. */
export function SheetFooter({ children, variant = 'default' }: { children: ReactNode; variant?: 'default' | 'bare' }) {
  const t = useTheme()
  const ctx = useContext(SheetContext)
  const fill = t.variant === 'dark' ? 'rgba(252, 252, 252, 0.0043)' : 'rgba(13, 13, 13, 0.0288)'
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 24,
        paddingRight: 24,
        flexShrink: 0,
        ...(variant === 'default'
          ? { paddingTop: 16, paddingBottom: 16, borderTopWidth: 1, borderColor: t.border, backgroundColor: fill }
          : { paddingTop: 12, paddingBottom: 24 }),
        // The inset sheet rounds the footer's bottom corners with the panel.
        ...(ctx?.inset ? { borderBottomLeftRadius: 17, borderBottomRightRadius: 17 } : {}),
      }}
    >
      {children}
    </div>
  )
}

/** `SheetClose render={<Button … />}`: a button that runs `onClick`, then closes the sheet. */
export function SheetClose({ children, variant = 'secondary', onClick, disabled, testId }: { children: string; variant?: ButtonVariant | ControlVariant; onClick?: () => void; disabled?: boolean; testId?: string }) {
  const ctx = useContext(SheetContext)
  const { variant: kind, danger } = controlVariant(variant)
  return <Button size="lg" variant={kind} danger={danger} disabled={disabled} testId={testId} onClick={() => { onClick?.(); ctx?.close() }}>{children}</Button>
}
