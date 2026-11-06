// The @ list's attached rows (#246): everything the draft already carries, in one inset panel with hairlines between rows. A
// leading accent check says "attached"; the grey fill says "the row Enter acts on", and only that row shows a × (Enter, Backspace
// and Delete remove it, as before). No count header and no "Attached"/"Remove" labels: the check and the × say it.
import type { ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { useControls } from '../kit/controls.ts'
import { Label, useTheme } from '../ui.tsx'
import { G } from './glyphs.ts'

export interface AttachedRow {
  /** Position in the picker's list, which the keyboard and the row test ids use. */
  index: number
  key: string
  title: string
  /** An image's source: drawn as a 20 px thumbnail instead of the type icon. */
  preview: string | null
  /** The type icon, drawn when there is no thumbnail. */
  icon: ReactNode
  /** What stands at the row's right edge while it is not the live row (a path, a project). */
  trail: ReactNode
}

const MEDIA = 20
const CHECK = 14
const GAP = 10
const PAD = 8
/** A hairline starts under the title: padding, check, gap, media, gap. */
const SEPARATOR_INSET = PAD + CHECK + GAP + MEDIA + GAP

export function AttachedGroup({
  rows,
  active,
  onHover,
  onPick,
}: {
  rows: AttachedRow[]
  active: number
  onHover: (index: number) => void
  onPick: (index: number) => void
}) {
  const t = useTheme()
  const controls = useControls()
  const light = t.variant === 'light'
  const fill = controls.ink(light ? 0.03 : 0.035)
  const edge = light ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.08)'
  const highlight = controls.ink(light ? 0.07 : 0.08)
  const hairline = controls.ink(light ? 0.069 : 0.072)
  return (
    <div testId="completion-attached-group" style={{ display: 'flex', flexDirection: 'column', padding: 2, borderRadius: 9, borderWidth: 1, borderColor: edge, backgroundColor: fill }}>
      {rows.map((row, at) => {
        const live = row.index === active
        const next = rows[at + 1]
        return (
          <div key={row.key} style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              testId={`completion-${row.index}`}
              aria-selected={live}
              aria-checked
              onMouseMove={() => !live && onHover(row.index)}
              onClick={() => onPick(row.index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: GAP,
                minHeight: 36,
                paddingLeft: PAD,
                paddingRight: PAD,
                paddingTop: 6,
                paddingBottom: 6,
                borderRadius: 7,
                cursor: 'pointer',
                ...(live ? { backgroundColor: highlight } : {}),
                hover: { backgroundColor: highlight },
              }}
            >
              <div testId={`completion-attached-${row.index}`} style={{ display: 'flex', width: CHECK, height: CHECK, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
                <Icon source={G.check} size={CHECK} color={controls.accentFg} />
              </div>
              <div style={{ position: 'relative', display: 'flex', width: MEDIA, height: MEDIA, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
                {row.preview ? (
                  <>
                    <img src={row.preview} objectFit="cover" style={{ width: MEDIA, height: MEDIA, borderRadius: 4, pointerEvents: 'none' }} />
                    <div style={{ position: 'absolute', left: 0, top: 0, width: MEDIA, height: MEDIA, borderRadius: 4, borderWidth: 1, borderColor: controls.ink(0.1), pointerEvents: 'none' }} />
                  </>
                ) : (
                  row.icon
                )}
              </div>
              <div testId={live ? 'completion-selected' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
                  <Label color={t.text} truncate>
                    {row.title}
                  </Label>
                </div>
                {live ? (
                  <div testId={`completion-remove-${row.index}`} aria-label={`Remove ${row.title}`} style={{ display: 'flex', width: 20, height: 20, marginRight: -4, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 5, hover: { backgroundColor: controls.ink(light ? 0.08 : 0.1) } }}>
                    <Icon source={G.x} size={12} color={t.textSecondary} />
                  </div>
                ) : (
                  row.trail
                )}
              </div>
            </div>
            {next && <div style={{ height: 1, marginLeft: SEPARATOR_INSET, marginRight: PAD, flexShrink: 0, backgroundColor: live || next.index === active ? 'transparent' : hairline }} />}
          </div>
        )
      })}
    </div>
  )
}
