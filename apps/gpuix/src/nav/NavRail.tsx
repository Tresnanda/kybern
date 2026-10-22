// The app rail (`views/NavRail.tsx` + `views/RailUsage.tsx`): Home, Notes,
// Tasks, Pull requests and Usage under one sliding pill, then the plan-usage
// rings and Settings at the foot. Every button has a tooltip on the right.
import { FILL_ISLAND } from '../MatrixLoader.tsx'
import { useTasks } from '../tasks/store.ts'
import { useEffect, useState } from 'react'
import {
  PROVIDER_NAMES,
  bindingLimit,
  limitLabel,
  limitLeftLabel,
  limitPace,
  limitTone,
  limitUsed,
  limitsStale,
  resetIn,
  staleCaption,
  updatedAgo,
} from '@/lib/providerUsage'
import type { ProviderKind, ProviderLimits } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { N } from './glyphs.ts'
import { goPage } from './history.ts'
import { askLimits } from './live.ts'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { muted, Tip } from './overlay.tsx'
import { useHover } from '../kit/hover.tsx'
import { getNav, setNav, useNav, type Page } from './store.ts'
import { openSettingsTab } from '../settings/SettingsScreen.tsx'
import { showDialog } from '../dialogs/store.ts'
import { RailUpdateButton } from '../platform/UpdateSurface.tsx'
import { CardAccounts, useCardEntry } from '../usage/CardAccounts.tsx'
import { AccountDot } from '../usage/AccountMark.tsx'
import { useAccountsFeed, useDefaultAccount } from '../usage/accounts.ts'
import { pressTransform } from '../motion/press.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { ringValue } from '../motion/success.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { fadeTo, pressRow } from '../shell/motion.ts'
import { RailSpaces, useRailSpacesVisible } from '../spaces/RailSpaces.tsx'

const RAIL = 52
const RAIL_ITEMS: { page: Page; icon: string; label: string }[] = [
  { page: 'home', icon: N.home, label: 'Home' },
  { page: 'notes', icon: N.note, label: 'Notes' },
  { page: 'tasks', icon: N.tasks, label: 'Tasks' },
  { page: 'pulls', icon: N.pullRequest, label: 'Pull requests' },
  { page: 'usage', icon: N.usage, label: 'Usage' },
]

/** `--app-rail-idle` / `--app-rail-hover` / `--app-rail-active` (`kit.css:131-133`). */
const railIdle = (t: Theme) => ink(t, 0.62)
const railHover = (t: Theme) => ink(t, 0.06)
const railActive = (t: Theme) => ink(t, 0.1)

/** A button and the gap under it: the pill travels one step per destination. */
const STEP = 42

export function NavRail() {
  const page = useNav((s) => s.page)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const t = useTheme()
  const destination = settingsOpen ? null : page
  const index = RAIL_ITEMS.findIndex((item) => item.page === destination)
  // ⌘1…⌘5 and the other shortcuts jump; a click slides (`keyboardNav` is cleared by any press).
  const keyboard = useNav((s) => s.keyboardNav)
  const jump = REDUCED_MOTION || keyboard
  const spacesShown = useRailSpacesVisible()
  return (
    // A cached island sized by its row (`cache="fill"`, native/README.md).
    // Empty rail space drags the window; the button groups do not (desktop `NavRail`).
    <div {...FILL_ISLAND} windowDrag style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: RAIL, flexShrink: 0, paddingBottom: 12 - 8 }}>
      <div windowDrag={false} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, position: 'relative' }}>
        {/* One sliding pill marks the active destination (`t-tabs-pill`, 250 ms smooth-out). It sits in the first destination's slot
            and is moved by paint (`paintTransform`): no layout or render per frame, where the old `top` tween re-laid out the window. */}
        <div
          paintTransform={PATCHED_NATIVE ? { initial: false, animate: { translateY: Math.max(index, 0) * STEP, opacity: index < 0 ? 0 : 1 }, transition: { duration: jump ? 0 : DURATION.fast, ease: [...EASE.smoothOut] } } : undefined}
          style={{ position: 'absolute', left: 0, top: 6, width: 36, height: 36, borderRadius: 10, backgroundColor: railActive(t), pointerEvents: 'none', ...(PATCHED_NATIVE ? {} : { top: 6 + Math.max(index, 0) * STEP, opacity: index < 0 ? 0 : 1 }) }}
        />
        {RAIL_ITEMS.map((item) => (
          <RailButton key={item.page} icon={item.icon} label={item.label} active={item.page === destination} onClick={() => goPage(item.page)} testId={`rail-${item.page}`} />
        ))}
      </div>
      {spacesShown ? <RailSpaces /> : <div style={{ flexGrow: 1 }} />}
      <div windowDrag={false} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <RailUsage />
        <RailUpdateButton />
        <RailButton
          icon={N.settings}
          label="Settings"
          shortcut={['⌘', ',']}
          active={settingsOpen}
          activeFill
          onClick={() => setNav({ settingsOpen: !getNav().settingsOpen })}
          testId="rail-settings"
        />
      </div>
    </div>
  )
}

function RailButton({
  icon,
  label,
  shortcut,
  active,
  activeFill,
  onClick,
  testId,
}: {
  icon: string
  label: string
  shortcut?: string[]
  active: boolean
  activeFill?: boolean
  onClick: () => void
  testId: string
}) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  return (
    <Tip label={label} shortcut={shortcut} side="right" sideOffset={6} size={36}>
      <div
        testId={testId}
        role="button"
        aria-label={label}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={onClick}
        paintTransform={pressTransform()}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          position: 'relative',
          borderRadius: 10,
          cursor: 'pointer',
          ...(active && activeFill ? { backgroundColor: railActive(t) } : {}),
          ...(active ? {} : { hover: { backgroundColor: railHover(t) } }),
        }}
      >
        <Icon source={icon} size={18} color={active || hover ? t.text : railIdle(t)} />
        {testId === 'rail-tasks' && <TasksReviewDot />}
      </div>
    </Tip>
  )
}

function TasksReviewDot() {
  const t = useTheme()
  const needsReview = useTasks((s) => Object.values(s.tasks).some((task) => task.status === 'needs_review'))
  return needsReview ? <div testId="tasks-review-dot" style={{ position: 'absolute', right: 5, top: 5, width: 5, height: 5, borderRadius: 3, backgroundColor: t.taskReview, pointerEvents: 'none' }} /> : null
}

// ---- plan usage rings ----

/** The card is `w-80` with 16px padding. */
const CARD_INNER = 320 - 32

const R = 10.25

/** A 24px ring: the track, and an arc for what is left, starting at 12 o'clock (`ringValue`: drawn in on its first value, then
 *  easing from value to value natively). */
const RING_TRACK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="${R}" stroke="#000" stroke-width="2"/></svg>`
function ringSvg(left: number | null): { track: string; arc: ReturnType<typeof ringValue> | null } {
  if (left === null || left <= 0) return { track: RING_TRACK, arc: null }
  return { track: RING_TRACK, arc: ringValue({ size: 24, radius: R, strokeWidth: 2, fraction: Math.min(100, left) / 100, drawIn: true }) }
}

function toneColor(t: Theme, tone: ReturnType<typeof limitTone>) {
  return tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : ink(t, 0.62)
}

/** One ring per provider, filled with what is left of its tightest limit; hovering opens its card. */
function RailUsage() {
  const providers = useNav((s) => s.limits)
  useAccountsFeed()
  // One shared card (`RailUsage.tsx`: 80 ms open, 100 ms close): moving to the next ring carries it over
  // without replaying it. The controller keeps one card visible app-wide and applies every leave.
  const { ctl, state } = useHover<ProviderKind>({ delay: 80, closeDelay: 100, hoverable: true })
  const now = Date.now()
  const glance = providers.flatMap((entry) => (entry.limits.length > 0 ? [{ entry, used: bindingLimit(entry.limits, now)?.used ?? null }] : []))
  if (glance.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      {glance.map(({ entry, used }) => (
        <UsageRing
          key={entry.provider}
          entry={entry}
          used={used}
          now={now}
          open={state.active === entry.provider}
          instant={state.instant}
          onEnter={() => ctl.enter(entry.provider)}
          onLeave={() => ctl.leave(entry.provider)}
          onCardEnter={() => ctl.popupEnter()}
          onCardLeave={() => ctl.popupLeave()}
        />
      ))}
    </div>
  )
}

function UsageRing({
  entry,
  used,
  now,
  open,
  onEnter,
  onLeave,
  onCardEnter,
  onCardLeave,
  instant,
}: {
  instant: boolean
  entry: ProviderLimits
  used: number | null
  now: number
  open: boolean
  onEnter: () => void
  onLeave: () => void
  onCardEnter: () => void
  onCardLeave: () => void
}) {
  const t = useTheme()
  const left = used === null ? null : 100 - used
  const stale = used === null || limitsStale(entry, now)
  const svg = ringSvg(left)
  // `.rail-usage-arc` (400 ms ease-out): the arc strokes itself in when it first has a value, then eases from the old value to the
  // new one (native, N2). Stale data dims (150 ms).
  const dim = fadeTo(stale ? 0.5 : 1)
  return (
    <div style={{ display: 'flex', position: 'relative' }}>
      <div
        testId={`rail-usage-${entry.provider}`}
        aria-label={`${used === null ? `${PROVIDER_NAMES[entry.provider] ?? entry.provider}: not read since reset` : `${PROVIDER_NAMES[entry.provider] ?? entry.provider}: ${Math.round(100 - used)}% left`}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={() => goPage('usage')}
        paintTransform={pressTransform()}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 10,
          cursor: 'pointer',
          ...(open ? { backgroundColor: railHover(t) } : {}),
          hover: { backgroundColor: railHover(t) },
        }}
      >
        <div paintTransform={dim.paintTransform} style={{ position: 'relative', width: 24, height: 24, pointerEvents: 'none', ...dim.style }}>
          <svg source={svg.track} style={{ position: 'absolute', left: 0, top: 0, width: 24, height: 24, color: ink(t, 0.12), pointerEvents: 'none' }} />
          {svg.arc && <svg source={svg.arc.source} {...(svg.arc.paintAnimation ? { paintAnimation: svg.arc.paintAnimation } : {})} style={{ position: 'absolute', left: 0, top: 0, width: 24, height: 24, color: toneColor(t, limitTone(used)), pointerEvents: 'none' }} />}
          <div style={{ position: 'absolute', left: 0, top: 0, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <ProviderMark kind={entry.provider} size={11} />
          </div>
          <DefaultDot kind={entry.provider} />
        </div>
      </div>
      {open && (
        // `PopoverPopup` (250 ms smooth-out, drifting from the ring's side); moving to
        // the next ring carries the card over without replaying it.
        <PopupLayer
          still={instant}
          side="right"
          align="end"
          sideOffset={8}
          onMouseEnter={onCardEnter}
          onMouseLeave={onCardLeave}
          style={{ ...popoverStyle(t), display: 'flex', flexDirection: 'column', width: 320, padding: 16, gap: 12 }}
        >
          <UsageCard entry={entry} />
        </PopupLayer>
      )}
    </div>
  )
}

/** A colored default account also wears its dot beside the ring (`DefaultRing`). */
function DefaultDot({ kind }: { kind: ProviderKind }) {
  const color = useDefaultAccount(kind)?.color
  return color ? <div style={{ position: 'absolute', right: -4, top: -4, pointerEvents: 'none' }}><AccountDot color={color} /></div> : null
}

/** A clickable row of the usage card: padded and pulled back by the same amount, so the text does not move and a held row has a body to darken. */
const cardRow = { cursor: 'pointer', borderRadius: 6, paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, marginLeft: -6, marginRight: -6, marginTop: -2, marginBottom: -2 } as const

/** A provider's limits (`AccountsUsageCard`, default account only). Opening re-reads them. */
function UsageCard({ entry: global }: { entry: ProviderLimits }) {
  const t = useTheme()
  const entry = useCardEntry(global.provider, global)
  const refreshing = useNav((s) => s.limitsRefreshing.includes(entry.provider))
  const now = Date.now()
  useEffect(() => {
    askLimits(true)
  }, [entry.provider])
  const name = PROVIDER_NAMES[entry.provider] ?? entry.provider
  const caption = staleCaption(entry, now)
  const ago = updatedAgo(entry.updated_at, now)
  const freshness = refreshing ? 'Updating…' : ago ? (limitsStale(entry, now) ? `Last updated ${ago}` : `Updated ${ago}`) : ''
  const small = muted(t, 1)
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ProviderMark kind={entry.provider} size={14} />
        <Label color={t.text} size={14} weight={500} truncate style={{ flexGrow: 1 }}>
          {name}
        </Label>
        <div testId="usage-card-details" onClick={() => goPage('usage')} style={{ ...cardRow, ...pressRow(t, t.buttonSecondaryHover) }}>
          <Label color={small}>Usage details</Label>
        </div>
      </div>
      <CardAccounts kind={entry.provider} global={global} />
      {entry.limits.map((limit) => {
        const used = limitUsed(limit, now)
        const left = used === null ? null : 100 - used
        const pace = limitPace(limit, now)
        const tone = limitTone(used)
        return (
          <div key={`${limit.window_minutes ?? ''}-${limit.name}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <Label color={t.text} truncate>
                {limitLabel(limit, entry.provider)}
              </Label>
              <Label color={small}>{limitLeftLabel(limit, now)}</Label>
            </div>
            {left !== null && (
              // `LimitMeter`: a 4px track that drains, and a tick where even spending would leave it.
              <div style={{ position: 'relative', paddingTop: 3, paddingBottom: 3 }}>
                <div style={{ height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: ink(t, 0.1), display: 'flex' }}>
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, left))}%`,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : ink(t, 0.65),
                    }}
                  />
                </div>
                {pace && <div style={{ position: 'absolute', top: 0, bottom: 0, left: (CARD_INNER * pace.evenLeft) / 100, width: 1.5, marginLeft: -0.75, borderRadius: 1, backgroundColor: ink(t, 0.45) }} />}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <Label color={small} size={13} truncate>
                {resetIn(limit.resets_at ?? null, now)}
              </Label>
              {pace && (
                <Label color={pace.short ? t.warning : small} size={13}>
                  {pace.label}
                </Label>
              )}
            </div>
          </div>
        )
      })}
      <Label color={small} size={13}>
        {!refreshing && caption ? caption : freshness}
      </Label>
      <div style={{ height: 1, marginLeft: -4, marginRight: -4, backgroundColor: ink(t, 0.07) }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: -4, marginBottom: -4 }}>
        <div testId="usage-card-accounts" onClick={() => openSettingsTab('accounts')} style={{ ...cardRow, ...pressRow(t, t.buttonSecondaryHover) }}>
          <Label color={small}>Manage accounts…</Label>
        </div>
        <div onClick={() => showDialog({ kind: 'account', provider: entry.provider })} style={{ ...cardRow, display: 'flex', alignItems: 'center', gap: 4, ...pressRow(t, t.buttonSecondaryHover) }}>
          <Icon source={N.plus} size={12} color={small} />
          <Label color={small}>Add account</Label>
        </div>
      </div>
    </>
  )
}
