// The desktop's `TimePicker` (`components/kit/time-picker.tsx`): two scrolling columns (hours 00-23, minutes 00-59)
// 176 px tall with a hairline between, each a column of small buttons (`Button size="sm"`: 28 px, radius 10,
// `--app-font-size-ui` medium; the chosen value `variant="default"` on `--primary`, the rest `ghost` in the
// secondary text colour, hover `--color-background-button-secondary-hover`). Opening centres the chosen value in its
// column, scrolling only that column. Emits "HH:MM". The scrollbars are hidden, as on the desktop.
import { useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { getAppTypographyScale } from '@/lib/kit/appTypography'
import { Label, useTheme } from '../ui.tsx'
import { FocusRing, useFocusRing, withAlpha } from './Switch.tsx'
import { Fill } from './Toggle.tsx'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
const ITEM = 28
const GAP = 2
const PAD = 4
const HEIGHT = 176
const TYPE = getAppTypographyScale()

const pad = (value: number) => value.toString().padStart(2, '0')

/** "HH:MM" → clamped hour and minute (00:00 when unreadable), like the desktop's `parseTime`. */
export function parseTime(value: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = value.split(':')
  const hour = Number.parseInt(rawHour ?? '', 10)
  const minute = Number.parseInt(rawMinute ?? '', 10)
  return { hour: Number.isNaN(hour) ? 0 : Math.min(23, Math.max(0, hour)), minute: Number.isNaN(minute) ? 0 : Math.min(59, Math.max(0, minute)) }
}

export interface TimePickerProps {
  value: string
  onChange: (value: string) => void
  /** Total width (the desktop fills its parent; columns share it). */
  width?: number
  testId?: string
  style?: StyleDesc
}

export function TimePicker({ value, onChange, width = 168, testId, style }: TimePickerProps) {
  const t = useTheme()
  const { hour, minute } = parseTime(value)
  return (
    <div testId={testId} style={{ display: 'flex', alignItems: 'stretch', gap: 4, height: HEIGHT, width, ...style }}>
      <TimeColumn label="Hour" testId={testId && `${testId}-hour`} values={HOURS} selected={hour} onSelect={(next) => onChange(`${pad(next)}:${pad(minute)}`)} />
      <div style={{ width: 1, flexShrink: 0, alignSelf: 'stretch', backgroundColor: t.v('--border') }} />
      <TimeColumn label="Minute" testId={testId && `${testId}-minute`} values={MINUTES} selected={minute} onSelect={(next) => onChange(`${pad(hour)}:${pad(next)}`)} />
    </div>
  )
}

function TimeColumn({ label, values, selected, onSelect, testId }: { label: string; values: readonly number[]; selected: number; onSelect: (value: number) => void; testId?: string }) {
  const renderer = useGpuixRequired()
  const scroll = useRef<PublicInstance>(null)
  // Centre the chosen value once, when the picker opens (`scrollTop = offsetTop - clientHeight / 2 + itemHeight / 2`; the item's clientHeight excludes its 1px borders).
  useLayoutEffect(() => {
    const top = PAD + selected * (ITEM + GAP) - HEIGHT / 2 + (ITEM - 2) / 2
    if (scroll.current) renderer.scrollTo?.(scroll.current.id, 0, -Math.max(0, top))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div ref={scroll} testId={testId} role="listbox" aria-label={label} style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0, overflowY: 'scroll' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP, padding: PAD, flexShrink: 0 }}>
        {values.map((entry) => <TimeOption key={entry} entry={entry} selected={entry === selected} onSelect={onSelect} testId={testId && `${testId}-${pad(entry)}`} />)}
      </div>
    </div>
  )
}

function TimeOption({ entry, selected, onSelect, testId }: { entry: number; selected: boolean; onSelect: (value: number) => void; testId?: string }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const focus = useFocusRing()
  return (
    <div
      testId={testId}
      role="option"
      aria-label={pad(entry)}
      aria-selected={selected}
      tabIndex={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={focus.handlers.onMouseDown}
      onFocus={focus.handlers.onFocus}
      onBlur={focus.handlers.onBlur}
      onClick={() => onSelect(entry)}
      onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { focus.keyed(); onSelect(entry) } }}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: ITEM, flexShrink: 0, borderRadius: 10, cursor: 'pointer', backgroundColor: selected ? t.v('--primary') : undefined }}
    >
      {/* `default`: `[:hover]:bg-primary/90`; `ghost`: the secondary-hover fill. */}
      <Fill on={hover} radius={10} color={selected ? withAlpha(t.v('--background'), 0.1) : t.v('--color-background-button-secondary-hover')} />
      <Label color={selected ? t.v('--primary-foreground') : hover ? t.text : t.textSecondary} size={TYPE.uiPx} lineHeight={21} weight={500} style={{ pointerEvents: 'none' }}>{pad(entry)}</Label>
      {/* `default`: `ring-1 ring-ring/60 ring-offset-1`; `ghost`: `ring-[--color-border-focus]/60`, no offset. */}
      <FocusRing visible={focus.visible} radius={10} width={1} offset={selected ? 1 : 0} color={withAlpha(selected ? t.v('--ring') : t.v('--color-border-focus'), 0.6)} offsetColor={t.v('--background')} />
    </div>
  )
}
