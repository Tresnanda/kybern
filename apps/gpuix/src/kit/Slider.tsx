// A continuous integer slider: a 160 × 4 track, an accent fill and a 16 px white thumb, with the value beside it.
//
// Ported from Synara, apps/web/src/components/ThemePackEditor.tsx (`ThemeSlider`) (MIT License):
//   Copyright (c) 2026 T3 Tools Inc.
//   Copyright (c) 2026 Emanuele Di Pietro
// Full notice: THIRD_PARTY_NOTICES.md at the repository root.
//
// Pointer: a press jumps to the pointer and a drag follows (bounds from `getElementBounds`, like `EffortSlider`),
// and releasing commits. `onChange` runs on every move (the caller throttles it), `onCommit` on release or a key.
// Hover and press feedback are instant and the thumb has no motion: this is a control used a hundred times a
// day (PORTING.md § Motion). Keys: ←/↓ −1, →/↑ +1, Shift ±10, Home/End min/max. Each key shows its value at once and goes
// through `onChange`; a run of keys (a held arrow) commits once, 250 ms after the last, or when focus leaves.
//
// `detents`: every integer from `min` to `max` is a stop with a 2 × 4 tick under the rail (Interface size's eight
// steps). `limit`: the largest value that can be chosen; the rail past it is dashed and its ticks faint, and the thumb
// stops there (sizes that do not fit the display).
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { Label, ink, useTheme } from '../ui.tsx'
import { useFocusRing } from './Switch.tsx'
import { useControls } from './controls.ts'

const TRACK = 160
const THUMB = 16
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const DASH = 4, GAP = 3

export function Slider({ value, min, max, onChange, onCommit, valueLabel, muted = false, 'aria-label': label, ariaValueText, disabled = false, testId, detents = false, limit }: {
  value: number; min: number; max: number
  /** A tick under the rail at each integer stop. */
  detents?: boolean
  /** The largest value that can be chosen (default `max`); the rest of the rail reads as unavailable. */
  limit?: number
  /** Live, on every move; the caller throttles it. */
  onChange: (value: number) => void
  /** Release, or the end of a run of key presses. */
  onCommit: (value: number) => void
  valueLabel: string
  /** Auto: the fill and the value read as inactive. */
  muted?: boolean
  'aria-label': string
  ariaValueText: string
  disabled?: boolean
  testId?: string
}) {
  const t = useTheme()
  const c = useControls()
  const { renderer } = useGpuix()
  const top = Math.min(max, Math.max(min, limit ?? max))
  const x = (v: number) => THUMB / 2 + ((v - min) / (max - min)) * (TRACK - THUMB)
  const track = useRef<PublicInstance | null>(null)
  const focus = useFocusRing()
  // A press and its release can arrive in one tick, before the drag state re-renders.
  const dragging = useRef<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? value
  const ratio = (shown - min) / (max - min)
  const fill = muted ? t.textTertiary : c.slider.fill
  // Key steps not yet committed: a held arrow repeats ~30 times a second, and each commit saves and rebuilds the theme.
  const keyed = useRef<number | null>(null)
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commit = useRef(onCommit)
  commit.current = onCommit
  const flushKeys = () => {
    clearTimeout(keyTimer.current)
    const next = keyed.current
    if (next === null) return
    keyed.current = null
    setDrag(null)
    commit.current(next)
  }
  useEffect(() => () => flushKeys(), [])

  const at = (x: number | undefined) => {
    const bounds = track.current ? renderer?.getElementBounds?.(track.current.id) : null
    if (!bounds || x === undefined) return dragging.current ?? value
    return Math.min(top, Math.round(min + clamp((x - bounds.x - THUMB / 2) / (bounds.width - THUMB), 0, 1) * (max - min)))
  }
  const move = (next: number) => {
    if (next === dragging.current) return
    dragging.current = next
    setDrag(next)
    onChange(next)
  }
  const end = (next: number) => {
    dragging.current = null
    setDrag(null)
    onCommit(next)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: disabled ? 0.45 : 1 }}>
      <div
        ref={(el) => { track.current = el }}
        testId={testId}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={ariaValueText}
        aria-disabled={disabled || undefined}
        onMouseDown={(e) => { focus.handlers.onMouseDown(); if (!disabled) move(at(e.x)) }}
        onMouseMove={(e) => { if (dragging.current !== null && e.pressedButton === 0) move(at(e.x)) }}
        onMouseUp={(e) => { if (dragging.current !== null) end(at(e.x)) }}
        onMouseLeave={() => { if (dragging.current !== null) end(dragging.current) }}
        onFocus={focus.handlers.onFocus}
        onBlur={() => { flushKeys(); focus.handlers.onBlur() }}
        onKeyDown={(e) => {
          if (disabled) return
          const step = (e.modifiers?.shift ? 10 : 1) * (e.key === 'right' || e.key === 'up' ? 1 : e.key === 'left' || e.key === 'down' ? -1 : 0)
          const from = keyed.current ?? value
          const next = e.key === 'home' ? min : e.key === 'end' ? top : step ? clamp(from + step, min, top) : null
          if (next === null) return
          e.preventDefault()
          focus.keyed()
          if (next === from) return
          keyed.current = next
          setDrag(next)
          onChange(next)
          clearTimeout(keyTimer.current)
          keyTimer.current = setTimeout(flushKeys, 250)
        }}
        style={{ position: 'relative', width: TRACK, height: 28, flexShrink: 0, borderRadius: 8, cursor: disabled ? 'default' : 'pointer', ...(disabled ? {} : { focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }) }}
      >
        {/* The parts paint fills, which would take the press from the track. */}
        <div style={{ position: 'absolute', left: 0, top: 12, width: top < max ? x(top) : TRACK, height: 4, borderRadius: 2, backgroundColor: c.slider.track, pointerEvents: 'none' }} />
        {top < max && Array.from({ length: Math.ceil((TRACK - x(top) - GAP) / (DASH + GAP)) }, (_, i) => {
          const left = x(top) + GAP + i * (DASH + GAP)
          return <div key={`dash${i}`} style={{ position: 'absolute', left, top: 12, width: Math.min(DASH, TRACK - left), height: 4, borderRadius: 1, backgroundColor: ink(t, 0.12), pointerEvents: 'none' }} />
        })}
        {detents && Array.from({ length: max - min + 1 }, (_, i) => <div key={`tick${i}`} style={{ position: 'absolute', left: x(min + i) - 1, top: 18, width: 2, height: 4, borderRadius: 1, backgroundColor: ink(t, min + i > top ? 0.08 : 0.25), pointerEvents: 'none' }} />)}
        <div style={{ position: 'absolute', left: 0, top: 12, width: THUMB / 2 + ratio * (TRACK - THUMB), height: 4, borderRadius: 2, backgroundColor: fill, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', left: ratio * (TRACK - THUMB), top: 6, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: '#ffffff', boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 0.5, color: 'rgba(0, 0, 0, 0.25)' }, { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.3)' }], pointerEvents: 'none' }} />
      </div>
      <div style={{ display: 'flex', width: 40, justifyContent: 'flex-end', flexShrink: 0 }}><Label color={t.textTertiary} size={13} lineHeight={18} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{valueLabel}</Label></div>
    </div>
  )
}
