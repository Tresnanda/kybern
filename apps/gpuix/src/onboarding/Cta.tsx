// The onboarding primary: a 44 px ink pill (the prototype's look) with the flow's microinteractions (SPEC §7): a press squash on
// pointer-down, a ripple of the label colour from the press point (clipped to the pill), a soft shine that crosses once per
// hover, and an arrow that nudges 3 px. All paint-only; the only React state is hover, which the arrow and shine read.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PaintTranslate } from '../drag/PaintTranslate.tsx'
import { Icon } from '../icons.tsx'
import { EASE, SCALE } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { N } from '../nav/glyphs.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import type { Theme } from '../theme.ts'
import { canvasColor } from './Grid.tsx'
import { magnetSupported, registerMagnet } from './magnet.ts'
import { bez } from './motion.tsx'

/** The label colour of a `Cta`, for a label built from nodes (a rolling number inside the words). */
export const ctaForeground = (t: Theme, off = false) => (off ? t.textTertiary : canvasColor(t))

export interface CtaProps {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  /** The trailing arrow (the default for a forward action). */
  arrow?: boolean
  /** Held down by the keyboard (Return on the hero): the squash plays without a pointer. */
  pressed?: boolean
  /** 0…1: a fill that grows inside the pill (an import's overall progress). */
  progress?: number
  testId?: string
  height?: number
  /** A leading element (an icon). */
  lead?: ReactNode
}

export function Cta({ children, onClick, disabled = false, busy = false, arrow = true, pressed = false, progress, testId, height = 44, lead }: CtaProps) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const root = useRef<PublicInstance | null>(null)
  const [hover, setHover] = useState(false)
  const [ripple, setRipple] = useState<{ x: number; y: number; n: number; w: number; h: number } | null>(null)
  const off = disabled || busy
  const bg = off ? t.buttonSecondary : t.text
  const fg = off ? t.textTertiary : canvasColor(t)
  const press = PATCHED_NATIVE && !off && !REDUCED_MOTION
  const run = () => { if (!off) onClick?.() }
  // The magnet moves this wrapper, not the pill: the pill keeps its own press and hover transforms.
  const wrap = useRef<PublicInstance | null>(null)
  const drift = magnetSupported(renderer, REDUCED_MOTION, PATCHED_NATIVE) && !off
  useEffect(() => (drift ? registerMagnet(renderer, () => wrap.current) : undefined), [renderer, drift])
  const shine = hover && press
  const sheen = t.variant === 'dark' ? 'rgba(13, 13, 13, 0.1)' : 'rgba(255, 255, 255, 0.2)'
  return (
    <div ref={wrap} style={{ display: 'flex', flexShrink: 0 }}>
    <div
      ref={root}
      testId={testId}
      role="button"
      tabIndex={off ? -1 : 0}
      aria-disabled={off || undefined}
      onClick={onClick ? run : undefined}
      onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') run() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => {
        if (off || !press || e.x === undefined || e.y === undefined) return
        const rect = root.current ? renderer.getElementBounds?.(root.current.id) : null
        if (rect) setRipple((old) => ({ x: e.x! - rect.x, y: e.y! - rect.y, n: (old?.n ?? 0) + 1, w: rect.width, h: rect.height }))
      }}
      paintTransform={pressed && press
        ? { initial: false, animate: { scale: SCALE.press }, transition: { duration: 0.12, ease: bez(EASE.out) }, retain: true }
        : pressTransform(!off, SCALE.press)}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, height, borderRadius: height / 2,
        paddingLeft: 22, paddingRight: arrow ? 18 : 22, backgroundColor: bg, overflow: 'hidden', cursor: off ? 'default' : 'pointer',
        ...(off ? {} : {
          boxShadow: { offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: -6, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(13, 13, 13, 0.32)' },
          focusVisible: { outlineWidth: 2, outlineColor: t.accentBlue, outlineOffset: 2 },
        }),
      }}
    >
      {progress !== undefined && progress > 0 && (
        <div
          paintTransform={PATCHED_NATIVE ? { initial: false, animate: { scaleX: Math.min(1, progress) }, transition: { duration: 0.4, ease: bez(EASE.out) }, origin: [0, 0.5], retain: true } : undefined}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, right: 0, backgroundColor: t.variant === 'dark' ? 'rgba(13, 13, 13, 0.14)' : 'rgba(255, 255, 255, 0.2)', pointerEvents: 'none' }}
        />
      )}
      {ripple && (
        <div key={ripple.n} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          <div
            paintTransform={{ initial: { scale: 0.02, opacity: 1 }, animate: { scale: 1, opacity: 0 }, transition: { duration: 0.65, ease: bez(EASE.out) } }}
            style={{ position: 'absolute', left: ripple.x - Math.hypot(ripple.w, ripple.h), top: ripple.y - Math.hypot(ripple.w, ripple.h), width: Math.hypot(ripple.w, ripple.h) * 2, height: Math.hypot(ripple.w, ripple.h) * 2, borderRadius: Math.hypot(ripple.w, ripple.h), backgroundColor: t.variant === 'dark' ? 'rgba(13, 13, 13, 0.22)' : 'rgba(255, 255, 255, 0.22)', pointerEvents: 'none' }}
          />
        </div>
      )}
      {shine && (
        <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          <div
            key="shine"
            paintTransform={{ initial: { translateX: -160 }, animate: { translateX: 340 }, transition: { duration: 0.7, ease: bez(EASE.out) } }}
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 80, display: 'flex', flexDirection: 'row', pointerEvents: 'none' }}
          >
            {[270, 90].map((angle) => (
              <div key={angle} style={{ width: 40, height: '100%', pointerEvents: 'none', background: { type: 'linear-gradient', angle, stops: [{ color: sheen, position: 0 }, { color: 'rgba(255, 255, 255, 0)', position: 1 }] } as never }} />
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
        {busy ? <Spinner size={14} color={fg} /> : lead}
        {typeof children === 'string' ? <Label color={fg} size={15} lineHeight={20} weight={600} style={{ whiteSpace: 'nowrap' }}>{children}</Label> : children}
        {arrow && (
          <PaintTranslate animate={{ translateX: hover && press ? 3 : 0, translateY: 0 }} transition={{ duration: 0.2, ease: bez(EASE.out) }} style={{ display: 'flex' }}>
            <Icon source={N.arrowRight} size={15} color={fg} style={{ pointerEvents: 'none' }} />
          </PaintTranslate>
        )}
      </div>
    </div>
    </div>
  )
}
