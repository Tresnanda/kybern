// The rows of the rail's update card (`platform/UpdateSurface.tsx`), laid out like a macOS Updates list: an icon tile, the
// name, and a tinted Update capsule. Kybern's own update is the first row; each harness with a newer version follows. Skipping
// a harness's version is in the row's context menu, so the rows carry no close buttons.
// A harness row stays, with a spinner in its capsule, while its harness waits for idle agents and updates.
import { useState, type ReactElement, type ReactNode } from 'react'
import type { EventPayload } from '@gpuix/react'
import { ContextMenu, MenuItem, Tip } from '../nav/overlay.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { useControls } from '../kit/controls.ts'
import { pressTransform } from '../motion/press.ts'
import { DURATION } from '../motion/tokens.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { FAILED_UPDATE_LINE, type UpdateRow } from './model.ts'
import { dismissHarness, updateHarnesses } from './store.ts'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'

/** Card geometry: the row radius plus the card's padding is the card's radius. */
export const CARD = { width: 296, padding: 6, radius: 14, rowRadius: 8, rowHeight: 44 } as const
const TILE = 28
const CAPSULE = { height: 24, padX: 11, minWidth: 64 } as const

/** The neutral square behind a row's logo. */
export function UpdateTile({ children }: { children: ReactNode }) {
  const c = useControls()
  const t = useTheme()
  return (
    <div style={{ display: 'flex', width: TILE, height: TILE, borderRadius: 7, alignItems: 'center', justifyContent: 'center', flexShrink: 0, backgroundColor: c.ink(t.variant === 'dark' ? 0.07 : 0.05), pointerEvents: 'none' }}>
      {children}
    </div>
  )
}

/**
 * The tinted action capsule ("Update", "Retry", "Restart"). Busy shows a spinner in place of the label (or beside `progress`)
 * and, like disabled, neither reacts nor scales.
 */
export function UpdateCapsule({ children, label, busy = false, disabled = false, onClick, testId, onMouseEnter, onMouseLeave, onMouseDown, onFocus, onBlur, onKeyDown }: {
  children: string
  label: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
  testId: string
} & TriggerHandlers) {
  const c = useControls()
  const off = busy || disabled
  return (
    <div testId={testId} role="button" aria-label={label} aria-disabled={off || undefined} tabIndex={off ? -1 : 0}
      // A `Tip` around the capsule composes its own handlers into these (and into `onClick`).
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseDown={onMouseDown} onFocus={onFocus} onBlur={onBlur}
      onClick={() => { if (!off) onClick() }}
      onKeyDown={(e) => { onKeyDown?.(e); if (!off && (e.key === 'enter' || e.key === 'space')) onClick() }}
      paintTransform={pressTransform(!off, 0.96, DURATION.quick, DURATION.quick)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0,
        height: CAPSULE.height, minWidth: CAPSULE.minWidth, paddingLeft: CAPSULE.padX, paddingRight: CAPSULE.padX, borderRadius: CAPSULE.height / 2,
        backgroundColor: c.acc(0.18), cursor: off ? 'default' : 'pointer',
        ...(off ? {} : { hover: { backgroundColor: c.acc(0.24) }, active: { backgroundColor: c.acc(0.28) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
      }}>
      {busy && <Spinner size={12} color={c.accentFg} />}
      {(!busy || /\d/.test(children)) && <Label color={c.accentFg} size={12} lineHeight={16} weight={600} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>{children}</Label>}
    </div>
  )
}

type Handler = (event: EventPayload) => void
/** What `Tip` (`kit/hover.tsx` `hoverTrigger`) puts on its trigger. */
type TriggerHandlers = { onMouseEnter?: Handler; onMouseLeave?: Handler; onMouseDown?: Handler; onFocus?: Handler; onBlur?: Handler; onKeyDown?: Handler }

/**
 * One row: tile, name, capsule. `onOpen` makes the tile and name a button (Kybern's row opens its release details); `menu` is
 * the context menu's items; `tip` is the capsule's tooltip (a failed update's next step).
 */
export function UpdateListRow({ testId, label, tile, name, capsule, onOpen, menu, tip }: {
  testId: string
  /** The row's accessible name: "Claude Code 2.1.330 is out". */
  label: string
  tile: ReactNode
  name: string
  capsule: ReactNode
  onOpen?: () => void
  menu?: ReactNode
  tip?: string
}) {
  const t = useTheme()
  const c = useControls()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const body = (
    <div testId={onOpen ? `${testId}-open` : undefined} role={onOpen ? 'button' : undefined} aria-label={onOpen ? label : undefined} tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen} onKeyDown={onOpen ? (e) => { if (e.key === 'enter' || e.key === 'space') onOpen() } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, minWidth: 0, height: CARD.rowHeight, cursor: onOpen ? 'pointer' : 'default' }}>
      {tile}
      <Label color={t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>{name}</Label>
    </div>
  )
  return (
    <div testId={testId} role="group" aria-label={label}
      onAuxClick={menu ? (e: { isRightClick?: boolean; button?: number; x?: number; y?: number }) => { if (e.isRightClick || e.button === 2) setAt({ x: e.x ?? 0, y: e.y ?? 0 }) } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 10, height: CARD.rowHeight, flexShrink: 0, paddingLeft: 8, paddingRight: 10, borderRadius: CARD.rowRadius, hover: { backgroundColor: c.ink(t.variant === 'dark' ? 0.06 : 0.045) } }}>
      {body}
      {/* The next step (a failed update, what Restart does) is the capsule's tooltip: it is about that action. */}
      {tip ? <Tip label={tip} side="top" size={CAPSULE.minWidth}>{capsule as ReactElement}</Tip> : capsule}
      {menu && at && <ContextMenu at={at} onClose={() => setAt(null)} testId={`${testId}-menu`}>{menu}</ContextMenu>}
    </div>
  )
}

/** A harness's row: its logo, its name, Update (Retry after a failed attempt), and Skip This Version in the context menu. */
export function HarnessUpdateRow({ row, starting }: { row: UpdateRow; starting: readonly ProviderKind[] }) {
  const busy = row.busy || starting.includes(row.kind)
  const action = row.failed ? 'Retry' : 'Update'
  return (
    <UpdateListRow testId={`harness-update-${row.kind}`} label={row.text} name={row.name}
      tile={<UpdateTile><ProviderMark kind={row.kind} size={18} /></UpdateTile>}
      tip={row.failed && !busy ? FAILED_UPDATE_LINE : undefined}
      capsule={<UpdateCapsule testId={`harness-update-${row.kind}-update`} label={busy ? `Updating ${row.name}` : `${action} ${row.name}`} busy={busy} onClick={() => void updateHarnesses([row.kind])}>{action}</UpdateCapsule>}
      menu={<MenuItem id="skip" testId={`harness-update-${row.kind}-skip`} label="Skip This Version" onSelect={() => dismissHarness(row.kind)} />} />
  )
}

/** The harnesses Update All starts: those not already waiting or updating. */
export function idleKinds(rows: readonly UpdateRow[], starting: readonly ProviderKind[]): ProviderKind[] {
  return rows.filter((row) => !row.busy && !starting.includes(row.kind)).map((row) => row.kind)
}
