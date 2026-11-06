// The model picker's harness rail (#249): Favorites at the top, then one row per agent account, each a mark and its name. The
// selected row is the kit's accent-tint pill, like every other selection. It scrolls instead of growing, so the popover keeps
// one size whichever agent is selected and however many are installed (a new one, such as Grok Build, is just another row).
import { memo, useState } from 'react'
import { nextTabIndex, type PickerTab } from '@/lib/accountUi'
import { PROVIDER_LABEL } from '@/lib/format'
import { Icon } from '../icons.tsx'
import { useControls } from '../kit/controls.ts'
import { Tip } from '../nav/overlay.tsx'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { G } from './glyphs.ts'

export const RAIL_WIDTH = 152
const ROW_HEIGHT = 30
const ROW_RADIUS = 6.4

type AccountTab = Extract<PickerTab, { type: 'account' }>

/** What a row says: "Favorites", or the agent / account name the tab carries. */
export const railLabel = (tab: PickerTab): string => (tab.type === 'starred' ? 'Favorites' : tab.rail || PROVIDER_LABEL[tab.kind as keyof typeof PROVIDER_LABEL] || tab.kind)

export function ModelRail({
  tabs,
  busy,
  onStarred,
  onAccount,
  bordered = true,
}: {
  tabs: PickerTab[]
  busy: boolean
  onStarred: () => void
  onAccount: (tab: AccountTab) => void
  /** A hairline on the right edge, where the pane begins. */
  bordered?: boolean
}) {
  const controls = useControls()
  const select = (tab: PickerTab) => {
    if (tab.type === 'starred') onStarred()
    else if (!tab.disabled) onAccount(tab)
  }
  const selectedAt = tabs.findIndex((tab) => tab.selected)
  // ↑/↓ (and ←/→) move to the neighbouring enabled row and select it, as the tab strip did.
  const step = (from: number, by: 1 | -1) => {
    const next = nextTabIndex(tabs as never, from, by)
    const tab = tabs[next]
    if (tab && next !== from) select(tab)
  }
  const [first, ...rest] = tabs
  const row = (tab: PickerTab, at: number) => (
    <RailRow key={tab.key} tab={tab} dimmed={tab.type === 'account' && (tab.disabled || (busy && !tab.selected))} focusable={at === Math.max(0, selectedAt)} onSelect={select} onStep={step} at={at} />
  )
  return (
    <div
      testId="model-tabs"
      role="tablist"
      aria-orientation="vertical"
      style={{ display: 'flex', flexDirection: 'column', width: RAIL_WIDTH, flexShrink: 0, padding: 6, gap: 2, ...(bordered ? { borderRightWidth: 1, borderColor: controls.ink(0.07) } : {}) }}
    >
      {first && row(first, 0)}
      <div style={{ height: 1, marginTop: 4, marginBottom: 4, marginLeft: 6, marginRight: 6, flexShrink: 0, backgroundColor: controls.ink(0.07) }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minHeight: 0, overflowY: 'scroll' }}>{rest.map((tab, i) => row(tab, i + 1))}</div>
    </div>
  )
}

const RailRow = memo(function RailRow({
  tab,
  at,
  dimmed,
  focusable,
  onSelect,
  onStep,
}: {
  tab: PickerTab
  at: number
  dimmed: boolean
  focusable: boolean
  onSelect: (tab: PickerTab) => void
  onStep: (from: number, by: 1 | -1) => void
}) {
  const t = useTheme()
  const controls = useControls()
  const label = railLabel(tab)
  const selected = tab.selected
  const color = selected ? controls.accentFg : t.textSecondary
  const hint = tab.type === 'account' && tab.tooltip !== label ? tab.tooltip : null
  const body = (
    <div
      testId={`model-tab-${tab.key}`}
      role="tab"
      aria-selected={selected}
      aria-label={tab.type === 'account' ? tab.ariaLabel : 'Favorites'}
      tabIndex={focusable ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={(event) => {
        if (event.key === 'enter' || event.key === 'space') onSelect(tab)
        else if (event.key === 'down' || event.key === 'right') onStep(at, 1)
        else if (event.key === 'up' || event.key === 'left') onStep(at, -1)
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Inside a tooltip's row wrapper the row grows to the rail's width; directly in the column it already stretches.
        ...(hint ? { flexGrow: 1 } : {}),
        flexShrink: 0,
        minWidth: 0,
        height: ROW_HEIGHT,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: ROW_RADIUS,
        cursor: 'pointer',
        ...(dimmed ? { opacity: 0.55 } : {}),
        ...(selected ? { backgroundColor: controls.chip.selBg } : {}),
        hover: { backgroundColor: selected ? controls.primary.hover : controls.ghost.hover },
      }}
    >
      <div style={{ display: 'flex', width: 14, height: 14, flexShrink: 0, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        {tab.type === 'starred' ? <Icon source={selected ? G.starFilled : G.star} size={14} color={selected ? t.v('--color-accent-yellow') : t.textSecondary} /> : <ProviderMark kind={tab.kind} size={14} />}
      </div>
      <Label color={color} weight={500} lineHeight={18} truncate style={{ pointerEvents: 'none' }}>
        {label}
      </Label>
    </div>
  )
  return hint ? (
    <Tip label={hint} side="right" size={ROW_HEIGHT}>
      {body}
    </Tip>
  ) : (
    body
  )
})
