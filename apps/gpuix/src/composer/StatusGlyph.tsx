// `ComposerStatusGlyph.tsx`: one 16px glyph in the composer tray. The ring is the context window, the centre dot is
// the prompt cache, and the arc takes a warning tone when context is high or the account is nearly out of limit.
// Hovering it (250 ms in, 100 ms out) or pressing it opens the popover: prompt cache, context window, the account's
// limits and a note, in the desktop's `provider-usage-*` layout (`kybern.css:720-795`) at its 14px base type.
import { useEffect, useState } from 'react'
import { contextUsage, bindingLimit, limitLabel, limitLeftLabel, limitPace, limitTone, limitUsed, resetIn } from '@/lib/providerUsage'
import { accountsOfKind, cacheState, cacheDotOpacity, cacheValue, glyphAriaLabel, glyphTone, type CacheState } from '@/lib/accountUi'
import { CLI_ACCOUNT_NAME, CLI_INSTANCE, isCliInstance } from '@/lib/accounts'
import { getAppTypographyScale } from '@/lib/kit/appTypography'
import { promptCacheWindow, promptCacheRemainingMinutes } from '@/lib/promptCache'
import type { ProviderInstance, ProviderUsage } from '../../../../packages/kybern-client/src/types.ts'
import { HoverScopeProvider, useHover } from '../kit/hover.tsx'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { useApp, usePaneAccess } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { useWindowWidth } from '../shell/layout.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { AccountMarkStack, LimitMeter } from '../usage/AccountMark.tsx'
import { loadAccountLimits, useAccountLimitEntries, useAccounts } from '../usage/accounts.ts'
import { useComposer } from './store.ts'
import { popoverStyle, PopupLayer } from './Menu.tsx'
import type { Theme } from '../theme.ts'
import { ringValue } from '../motion/success.ts'
import { refreshContext, useRefreshPoint, useRotationPending } from '../coordinator/rotation.ts'
import { formatTokens, ROTATION_COPY } from '../../../../packages/kybern-client/src/rotation.ts'
import { Button } from '../kit/Button.tsx'

type Limits = NonNullable<ProviderUsage['limits']>

/** `w-[19rem]`, `rounded-2xl` (`--radius-2xl`), and the popover's `px-4 py-4` viewport padding. */
const WIDTH = 304
const RADIUS = 18
const PAD = 16
/** `--app-font-size-ui` and `-ui-sm` (`provider-usage-content` and `-caption`), from the desktop's typography scale. */
const TYPE = getAppTypographyScale()
const UI = TYPE.uiPx
const SM = TYPE.uiSmPx
/** `provider-usage-value`: 1.75rem, line-height 1.1, -0.035em tracking. */
const VALUE = 28
const VALUE_TRACKING = VALUE * 0.035
/** One tabular digit and the percent sign in `provider-usage-value`, tracking included (measured in the desktop's WebKit). */
const VALUE_CELL: Record<string, number> = { '%': 23.5625 }
const VALUE_DIGIT = 17.125
/** The trigger is 28px with the popup's right edge on its right edge: its centre is 14px in. */
const ORIGIN: [number, number] = [(WIDTH - 14) / WIDTH, 1]

/** The ring is context usage; the centre dot is the provider's cache window. */
export function StatusGlyph({ provider, running }: { provider: ProviderInstance; running?: boolean }) {
  const t = useTheme()
  const pane = usePaneAccess()
  const usage = useApp(s => s.open.providerUsage)
  const activity = useApp(s => {
    for (let i = s.open.blocks.length - 1; i >= 0; i--) if (s.open.blocks[i]?.kind === 'turn_end') return s.open.blocks[i]!.at
    return undefined
  })
  const env = useComposer(s => s.settings?.providers[provider.kind]?.env)
  const kind = provider.kind
  const instance = provider.instance ?? CLI_INSTANCE
  const accounts = useAccounts(kind)
  const own = accountsOfKind(accounts, kind)
  const multi = own.length > 1
  const account = own.find(entry => entry.provider.instance === instance)
  const accountName = isCliInstance(instance) ? CLI_ACCOUNT_NAME : account?.name ?? 'Account'
  const entries = useAccountLimitEntries()
  const global = useNav(s => s.limits.find(l => l.provider === kind))
  // The default account's limits are the daemon's global entry, polled anyway. Any other account is read only while the popover is open.
  const needsOwnRead = multi && !!account && !account.is_default
  const windowWidth = useWindowWidth()
  const { ctl, state } = useHover<true>({ delay: 250, closeDelay: 100, hoverable: true })
  const open = state.active !== null
  useEffect(() => {
    if (open && needsOwnRead) loadAccountLimits([{ kind, instance }])
  }, [open, kind, instance, needsOwnRead])
  const entry = entries.find(item => item.provider === kind && item.instance === instance) ?? (!multi || account?.is_default ? global : undefined)
  const limits: Limits | undefined = entry?.limits.length ? entry.limits : multi ? undefined : usage?.limits

  const window = promptCacheWindow(kind, env)
  const [now, setNow] = useState(Date.now)
  const remaining = activity && window ? promptCacheRemainingMinutes(activity, window.ttlMinutes, now) : 0
  // One 15 s clock, only while a warm cache has a minute count to keep right, and only while the window is visible.
  useEffect(() => {
    if (!remaining || running || pane.frozen) return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      if (isWindowVisible() && !timer) { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 15_000) }
      else if (!isWindowVisible() && timer) { clearInterval(timer); timer = undefined }
    }
    const stop = onWindowVisibility(sync)
    sync()
    return () => { stop(); if (timer) clearInterval(timer) }
  }, [remaining > 0, running, activity, pane.frozen])
  const cache: CacheState | null = activity && window ? cacheState(!!running, remaining) : null
  const context = contextUsage(usage?.context)
  // A project Coordinator refreshes its context at a budget: a tick on the ring and a row in the popover (spec §10.1).
  const thread = useApp(s => s.open.thread)
  const refreshAt = useRefreshPoint(thread, context?.window)
  const rotating = useRotationPending(!!thread?.coordinator_project_id)
  const tick = context && refreshAt && refreshAt < context.window ? refreshAt / context.window : null
  const binding = limits ? bindingLimit(limits, now) : null
  const leftPercent = binding ? 100 - binding.used : null
  const tone = glyphTone(context?.percent ?? null, leftPercent)
  const [hovered, setHovered] = useState(false)
  if (!context && !cache && !limits?.length) return null
  const label = glyphAriaLabel({
    contextPercent: context?.percent ?? null,
    cache,
    account: binding && leftPercent !== null ? { name: multi ? accountName : 'Account', leftPercent, windowLabel: limitLabel(binding.limit, kind) } : null,
  })
  // `text-muted-foreground hover:text-foreground data-popup-open:text-foreground`; only the arc takes the tone.
  const base = hovered || open ? t.text : ink(t, t.variant === 'dark' ? 0.58 : 0.598)
  const arc = tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : base
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">'
  // The budget tick: a short radial stroke across the ring at the share of the window where the refresh happens.
  const budgetTick = tick ? `<path d="M12 .8v3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" transform="rotate(${Math.round(tick * 3600) / 10} 12 12)"/>` : ''
  const backdrop = `${head}<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity=".2"/>${cache && cache.state !== 'cold' ? `<circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="${cacheDotOpacity(cache)}"/>` : ''}${budgetTick}</svg>`
  // Context used: eases from the old share to the new one after each turn (native ring, N2); it mounts at its value.
  const ring = context ? ringValue({ size: 24, radius: 9, strokeWidth: 2.5, fraction: context.percent / 100 }) : null
  const trigger = (
    <div
      testId="composer-status"
      role="button"
      tabIndex={0}
      aria-label={label}
      onMouseEnter={() => { setHovered(true); ctl.enter(true) }}
      onMouseLeave={() => { setHovered(false); ctl.leave(true) }}
      // A press opens at once; a popover already open from hover stays open (Base UI `stickIfOpen`).
      onClick={() => { if (ctl.active === null) ctl.openNow(true) }}
      onKeyDown={event => {
        if (event.key === 'enter' || event.key === 'space') ctl.openNow(true)
        else if (event.key === 'escape') ctl.hide()
      }}
      onBlur={() => ctl.hide()}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flexShrink: 0, borderRadius: 14, cursor: 'pointer', backgroundColor: open ? t.hover : undefined, hover: { backgroundColor: t.hover } }}
    >
      <svg source={backdrop} style={{ position: 'absolute', left: 6, top: 6, width: 16, height: 16, color: base, pointerEvents: 'none' }} />
      {ring && <svg source={ring.source} {...(ring.paintAnimation ? { paintAnimation: ring.paintAnimation } : {})} style={{ position: 'absolute', left: 6, top: 6, width: 16, height: 16, color: arc, pointerEvents: 'none' }} />}
    </div>
  )
  return (
    <div style={{ display: 'flex', position: 'relative', flexShrink: 0 }}>
      {trigger}
      {open && (
        <PopupLayer
          testId="composer-status-popover"
          side="top"
          align="end"
          sideOffset={10}
          still={state.instant}
          materialize={state.instant ? undefined : { origin: ORIGIN }}
          onMouseEnter={() => ctl.popupEnter()}
          onMouseLeave={() => ctl.popupLeave()}
          style={{ ...popoverStyle(t), borderRadius: RADIUS, boxShadow: shadowXl(t), width: WIDTH, maxWidth: Math.max(WIDTH / 2, windowWidth - 32), padding: PAD, display: 'flex', flexDirection: 'column' }}
        >
          <HoverScopeProvider ctl={ctl as never}>
            <UsagePopover usage={usage} kind={kind} promptProvider={window?.providerLabel ?? null} ttl={window?.ttlMinutes ?? 0} cache={cache} remaining={remaining} limits={limits} accountName={multi ? accountName : null} accountColor={account?.color ?? null} refresh={thread && refreshAt !== null ? { point: refreshAt, tick, disabled: !!running || rotating, onRefresh: () => void refreshContext(thread.id) } : undefined} />
          </HoverScopeProvider>
        </PopupLayer>
      )}
    </div>
  )
}

/** Tailwind `shadow-xl` (its larger layer), `popover.tsx`'s `rounded-2xl shadow-xl`. */
function shadowXl(t: Theme) {
  return { offsetX: 0, offsetY: 20, blurRadius: 25, spreadRadius: -5, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.30)' : 'rgba(0, 0, 0, 0.10)' }
}

/** Re-render every 60 s while the popover is open, so the "resets in" lines stay right. Nothing runs while it is closed. */
function useOpenClock(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function UsagePopover({
  usage,
  kind,
  promptProvider,
  ttl,
  cache,
  remaining,
  limits,
  accountName,
  accountColor,
  refresh,
}: {
  usage?: ProviderUsage
  kind: ProviderInstance['kind']
  promptProvider: string | null
  ttl: number
  cache: CacheState | null
  remaining: number
  limits?: Limits
  accountName: string | null
  accountColor: string | null
  /** A project Coordinator: where it refreshes (0 is off), as a share of the window, and the manual refresh. */
  refresh?: { point: number; tick: number | null; disabled: boolean; onRefresh: () => void }
}) {
  const t = useTheme()
  const now = useOpenClock()
  const context = usage ? contextUsage(usage.context) : null
  const ctxTone = context && context.percent >= 95 ? 'critical' : context && context.percent >= 80 ? 'warning' : 'normal'
  const detail = !promptProvider || !cache
    ? null
    : cache.state === 'active'
      ? `${promptProvider} is actively using this conversation.`
      : cache.state === 'warm'
        ? `About ${remaining} minute${remaining === 1 ? '' : 's'} remain in the documented ${ttl}-minute warm window.`
        : `The documented ${ttl}-minute warm window has elapsed.`
  const muted = ink(t, t.variant === 'dark' ? 0.58 : 0.598)
  return (
    <div testId="composer-status-content" style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
      {cache && detail && (
        // `mb-6`; the heading `!mb-2` and the caption `!mt-0`.
        <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 24 }}>
          <Heading label="Prompt cache" muted={muted} style={{ marginBottom: 8 }}>
            <Label color={t.text} size={UI} lineHeight={UI * 1.5} weight={500}>{cacheValue(cache)}</Label>
          </Heading>
          <Caption color={muted}>{`${detail} Actual retention may be longer.`}</Caption>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Heading label="Context window" muted={muted} style={{ marginBottom: 12 }}>
          <BigValue color={t.text}>{context ? `${Math.round(context.percent)}%` : '—'}</BigValue>
        </Heading>
        {/* The heading's `mb-3` and the caption's `mt-2` are adjacent block margins on the desktop: they collapse to 12px, not 20. */}
        {context ? <>
          <UsageMeter percent={context.percent} tone={ctxTone} label="Context used" tick={refresh?.tick ?? undefined} />
          <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 8 }}>
            <Label color={t.text} size={SM} lineHeight={SM * 1.5}>{context.used.toLocaleString()}</Label>
            <Label color={muted} size={SM} lineHeight={SM * 1.5}>{` of ${context.window.toLocaleString()} tokens`}</Label>
          </div>
        </> : <Caption color={muted}>Context usage hasn’t been reported yet.</Caption>}
        {refresh && (
          <div testId="composer-status-refresh" style={{ display: 'flex', flexDirection: 'column', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderColor: ink(t, 0.06) }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}>
                <Label color={t.text} size={SM} lineHeight={SM * 1.5}>{refresh.point > 0 ? `${ROTATION_COPY.refreshAt} ${formatTokens(refresh.point)}` : ROTATION_COPY.refreshOff}</Label>
                <Caption color={muted} style={{ fontSize: 12, lineHeight: 16 }}>{ROTATION_COPY.refreshMeta}</Caption>
              </div>
              <Button variant="ghost" size="sm" testId="composer-status-refresh-now" disabled={refresh.disabled} onClick={refresh.onRefresh}>{ROTATION_COPY.refreshNow}</Button>
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 24 }}>
        <div testId="composer-status-limits-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, minWidth: 0 }}>
          {accountName ? <>
            <Label color={muted} size={UI} lineHeight={UI * 1.5} style={{ flexShrink: 0 }}>Account limits —</Label>
            <AccountMarkStack kind={kind} color={accountColor} size={12} />
            <Label color={t.text} size={UI} lineHeight={UI * 1.5} truncate>{accountName}</Label>
          </> : <Label color={muted} size={UI} lineHeight={UI * 1.5}>Account limits</Label>}
        </div>
        {/* Likewise the label's 10px and the caption's 8px collapse to 10px when no limit is reported. */}
        {limits?.length ? limits.map((limit, index) => {
          const used = limitUsed(limit, now)
          const name = limitLabel(limit, kind)
          const pace = limitPace(limit, now)
          return (
            <div key={`${limit.name}-${index}`} testId="composer-status-limit" data-tone={limitTone(used)} style={{ display: 'flex', flexDirection: 'column', marginTop: index === 0 ? 0 : 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 12, rowGap: 4, marginBottom: 8, minWidth: 0 }}>
                <Label color={t.text} size={UI} lineHeight={UI * 1.5} weight={500} style={{ minWidth: 0, flexShrink: 1 }}>{name}</Label>
                <Label color={muted} size={UI} lineHeight={UI * 1.5} weight={500}>{limitLeftLabel(limit, now)}</Label>
              </div>
              {used !== null && <LimitMeter left={100 - used} pace={pace} label={`${name} left`} />}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: used === null ? 0 : 8 }}>
                <Label color={muted} size={SM} lineHeight={SM * 1.5} truncate>{resetIn(limit.resets_at ?? null, now)}</Label>
                {pace && <Label color={pace.short ? t.warning : muted} size={SM} lineHeight={SM * 1.5} style={{ flexShrink: 0 }}>{pace.label}</Label>}
              </div>
            </div>
          )
        }) : <Caption color={muted}>Account limits haven’t been reported yet.</Caption>}
      </div>
      <Caption color={muted} style={{ marginTop: 20 }}>Context can decrease after compaction.</Caption>
    </div>
  )
}

/** `provider-usage-heading`: muted title on the left, the value on the right, 16px apart. */
function Heading({ label, muted, children, style }: { label: string; muted: string; children: React.ReactNode; style?: Record<string, unknown> }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, ...style }}>
      <Label color={muted} size={UI} lineHeight={UI * 1.5} weight={500}>{label}</Label>
      <div style={{ display: 'flex', flexShrink: 0 }}>{children}</div>
    </div>
  )
}

/**
 * `provider-usage-value`: 1.75rem, 600, `tabular-nums`, -0.035em tracking. GPUIX text has neither, so each character
 * sits in a cell as wide as the desktop's tabular digit (or percent sign) with its tracking. The value then has
 * one width per digit count, so nothing shifts as it updates.
 */
function BigValue({ children, color }: { children: string; color: string }) {
  return (
    <div style={{ display: 'flex', height: VALUE * 1.1 }}>
      {[...children].map((char, index) => {
        const digit = /\d/.test(char)
        const width = digit ? VALUE_DIGIT : VALUE_CELL[char]
        // A figure is centred in its cell, as a tabular one is; any other character starts at the cell's left edge.
        return (
          <div key={index} style={{ display: 'flex', flexShrink: 0, ...(digit ? { justifyContent: 'center', paddingLeft: VALUE_TRACKING } : {}), ...(width ? { width } : {}) }}>
            <Label color={color} size={VALUE} lineHeight={VALUE * 1.1} weight={600} style={{ flexShrink: 0 }}>{char}</Label>
          </div>
        )
      })}
    </div>
  )
}

/** `provider-usage-caption`: 13px, muted, wraps anywhere. */
function Caption({ children, color, style }: { children: string; color: string; style?: Record<string, unknown> }) {
  return <text style={{ color, fontSize: SM, lineHeight: SM * 1.5, minWidth: 0, userSelect: 'none', ...style }}>{children}</text>
}

/** `provider-usage-meter`: a 4px pill, ink 10% track, ink 65% fill (warning or destructive near the limit). */
function UsageMeter({ percent, tone, label, tick }: { percent: number; tone: 'normal' | 'warning' | 'critical'; label: string; /** Where a Coordinator refreshes, as a share of the window (0-1): a 2 × 12 px mark across the track. */ tick?: number }) {
  const t = useTheme()
  const fill = tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : ink(t, 0.65)
  const meter = (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: ink(t, 0.1) }}>
      <div style={{ width: `${Math.max(0, Math.min(100, percent))}%`, height: 4, borderRadius: 2, backgroundColor: fill }} />
    </div>
  )
  if (tick === undefined) return meter
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {meter}
      <div style={{ position: 'absolute', top: -4, left: 0, right: 0, display: 'flex', pointerEvents: 'none' }}>
        <div style={{ width: `${Math.max(0, Math.min(100, tick * 100))}%`, flexShrink: 0 }} />
        <div testId="composer-status-tick" style={{ marginLeft: -1, width: 2, height: 12, borderRadius: 1, backgroundColor: t.text, flexShrink: 0 }} />
      </div>
    </div>
  )
}
