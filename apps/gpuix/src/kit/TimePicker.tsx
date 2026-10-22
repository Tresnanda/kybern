// The desktop's `TimePicker` (`components/kit/time-picker.tsx`): two scrolling columns (hours 00-23, minutes 00-59)
// 176 px tall with a hairline between, each a column of small buttons (`Button size="sm"`: 28 px, radius 10,
// `--app-font-size-ui` medium; the chosen value `variant="default"` on `--primary`, the rest `ghost` in the
// secondary text colour, hover `--color-background-button-secondary-hover`). Opening centres the chosen value in its
// column, scrolling only that column. Emits "HH:MM". The scrollbars are hidden, as on the desktop.
import { useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { getAppTypographyScale } from '@/lib/kit/appTypography'
import { Label, useTheme } from '../ui.tsx'
import { Button } from './Button.tsx'

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
  return <Button block variant={selected ? 'primary' : 'ghost'} testId={testId} label={pad(entry)} onClick={() => onSelect(entry)}>{pad(entry)}</Button>
}
