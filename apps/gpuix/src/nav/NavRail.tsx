// The app rail (`views/NavRail.tsx` + `views/RailUsage.tsx`): Home, Notes,
// Tasks, Pull requests and Usage under one sliding pill, then the plan-usage
// rings and Settings at the foot. Every button has a tooltip on the right.
import { FILL_ISLAND } from '../MatrixLoader.tsx'
import { motion } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
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
import { EASE_OUT, ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { N } from './glyphs.ts'
import { goPage } from './history.ts'
import { askLimits } from './live.ts'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { muted, Tip } from './overlay.tsx'
import { getNav, setNav, useNav, type Page } from './store.ts'

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

const SLIDE = REDUCED_MOTION ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }

export function NavRail() {
  const page = useNav((s) => s.page)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const t = useTheme()
  const destination = settingsOpen ? null : page
  const index = RAIL_ITEMS.findIndex((item) => item.page === destination)
  return (
    // A cached island sized by its row (`cache="fill"`, native/README.md).
    <div {...FILL_ISLAND} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: RAIL, flexShrink: 0, paddingBottom: 12 - 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, position: 'relative' }}>
        {/* One sliding pill marks the active destination (`motion.css:396`). */}
        <motion.div
          initial={false}
          animate={{ top: 6 + Math.max(index, 0) * 42, opacity: index < 0 ? 0 : 1 }}
          transition={SLIDE}
          style={{ position: 'absolute', left: 0, width: 36, height: 36, borderRadius: 10, backgroundColor: railActive(t), pointerEvents: 'none' }}
        />
        {RAIL_ITEMS.map((item) => (
          <RailButton key={item.page} icon={item.icon} label={item.label} active={item.page === destination} onClick={() => goPage(item.page)} testId={`rail-${item.page}`} />
        ))}
      </div>
      <div style={{ flexGrow: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <RailUsage />
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
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 10,
          cursor: 'pointer',
          ...(active && activeFill ? { backgroundColor: railActive(t) } : {}),
          ...(active ? {} : { hover: { backgroundColor: railHover(t) } }),
        }}
      >
        <Icon source={icon} size={18} color={active || hover ? t.text : railIdle(t)} />
      </div>
    </Tip>
  )
}

// ---- plan usage rings ----

/** The card is `w-80` with 16px padding. */
const CARD_INNER = 320 - 32

const R = 10.25
const CIRCUMFERENCE = 2 * Math.PI * R

/** A 24px ring: the track, and an arc for what is left, starting at 12 o'clock. */
function ringSvg(left: number | null): { track: string; arc: string | null } {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">'
  const track = `${head}<circle cx="12" cy="12" r="${R}" stroke="#000" stroke-width="2"/></svg>`
  if (left === null) return { track, arc: null }
  const length = (Math.max(0, Math.min(100, left)) / 100) * CIRCUMFERENCE
  const arc = `${head}<circle cx="12" cy="12" r="${R}" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-dasharray="${length.toFixed(3)} ${CIRCUMFERENCE.toFixed(3)}" transform="rotate(-90 12 12)"/></svg>`
  return { track, arc }
}

function toneColor(t: Theme, tone: ReturnType<typeof limitTone>) {
  return tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : ink(t, 0.62)
}

/** One ring per provider, filled with what is left of its tightest limit; hovering opens its card. */
function RailUsage() {
  const providers = useNav((s) => s.limits)
  const [card, setCard] = useState<ProviderKind | null>(null)
  // The card opens with the popover motion; moving to the next ring carries it over without replaying it.
  const [carried, setCarried] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
  }, [])
  const now = Date.now()
  const glance = providers.flatMap((entry) => (entry.limits.length > 0 ? [{ entry, used: bindingLimit(entry.limits, now)?.used ?? null }] : []))
  if (glance.length === 0) return null
  // One shared card: moving to the next ring carries it over (80ms open, 100ms close).
  const enter = (kind: ProviderKind) => {
    clearTimeout(closeTimer.current)
    clearTimeout(openTimer.current)
    if (card) {
      if (card !== kind) setCarried(true)
      return setCard(kind)
    }
    openTimer.current = setTimeout(() => {
      setCarried(false)
      setCard(kind)
    }, 80)
  }
  const leave = () => {
    clearTimeout(openTimer.current)
    closeTimer.current = setTimeout(() => setCard(null), 100)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      {glance.map(({ entry, used }) => (
        <UsageRing
          key={entry.provider}
          entry={entry}
          used={used}
          now={now}
          open={card === entry.provider}
          carried={carried}
          onEnter={() => enter(entry.provider)}
          onLeave={leave}
          onCardEnter={() => clearTimeout(closeTimer.current)}
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
  carried,
}: {
  carried: boolean
  entry: ProviderLimits
  used: number | null
  now: number
  open: boolean
  onEnter: () => void
  onLeave: () => void
  onCardEnter: () => void
}) {
  const t = useTheme()
  const left = used === null ? null : 100 - used
  const stale = used === null || limitsStale(entry, now)
  const svg = ringSvg(left)
  return (
    <div style={{ display: 'flex', position: 'relative' }}>
      <div
        testId={`rail-usage-${entry.provider}`}
        aria-label={`${used === null ? `${PROVIDER_NAMES[entry.provider] ?? entry.provider}: not read since reset` : `${PROVIDER_NAMES[entry.provider] ?? entry.provider}: ${Math.round(100 - used)}% left`}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={() => goPage('usage')}
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
        <div style={{ position: 'relative', width: 24, height: 24, opacity: stale ? 0.5 : 1, pointerEvents: 'none' }}>
          <svg source={svg.track} style={{ position: 'absolute', left: 0, top: 0, width: 24, height: 24, color: ink(t, 0.12), pointerEvents: 'none' }} />
          {svg.arc && <svg source={svg.arc} style={{ position: 'absolute', left: 0, top: 0, width: 24, height: 24, color: toneColor(t, limitTone(used)), pointerEvents: 'none' }} />}
          <div style={{ position: 'absolute', left: 0, top: 0, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <ProviderMark kind={entry.provider} size={11} />
          </div>
        </div>
      </div>
      {open && (
        // `PopoverPopup` (250 ms smooth-out, drifting from the ring's side); moving to
        // the next ring carries the card over without replaying it.
        <PopupLayer
          still={carried}
          side="right"
          align="end"
          sideOffset={8}
          onMouseEnter={onCardEnter}
          onMouseLeave={onLeave}
          style={{ ...popoverStyle(t), display: 'flex', flexDirection: 'column', width: 320, padding: 16, gap: 12 }}
        >
          <UsageCard entry={entry} />
        </PopupLayer>
      )}
    </div>
  )
}

/** A provider's limits (`AccountsUsageCard`, default account only). Opening re-reads them. */
function UsageCard({ entry }: { entry: ProviderLimits }) {
  const t = useTheme()
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
        <div onClick={() => goPage('usage')} style={{ cursor: 'pointer' }}>
          <Label color={small}>Usage details</Label>
        </div>
      </div>
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
        <div onClick={() => setNav({ settingsOpen: true })} style={{ cursor: 'pointer' }}>
          <Label color={small}>Manage accounts…</Label>
        </div>
        <div onClick={() => setNav({ settingsOpen: true })} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <Icon source={N.plus} size={12} color={small} />
          <Label color={small}>Add account</Label>
        </div>
      </div>
    </>
  )
}
