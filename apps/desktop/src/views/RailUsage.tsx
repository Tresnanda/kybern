// Plan usage at a glance, in the app rail above Settings: one ring per provider,
// filled with what is left of its tightest limit. Hovering a ring opens that
// provider's card; moving to the next ring carries the same card over without
// closing it (one shared popover, per the HIG's one-popover-at-a-time rule).
// Opening asks the daemon to re-read, so the numbers are current when looked at.
// The card never scrolls, so the resize between providers shows no scrollbar.
// When a read fails the card says why and what brings the numbers back, and a
// window that reset since its last reading shows no number rather than "100% left".

import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/kit/popover"
import { ProviderMark } from "@/components/kybern/bits"
import { LimitMeter } from "@/components/kybern/LimitMeter"
import { useNow } from "@/lib/hooks"
import { PROVIDER_NAMES, bindingLimit, limitLabel, limitLeftLabel, limitPace, limitTone, limitUsed, limitsStale, resetIn, staleReason, updatedAgo } from "@/lib/providerUsage"
import type { ProviderKind, ProviderLimits } from "@/protocol"
import { refreshUsageLimits, useAccountLimits, useProviderLimits, useRefreshingLimits } from "@/state/usageLimits"

const usageCard = PopoverCreateHandle<ProviderKind>()

export function RailUsage() {
  const providers = useAccountLimits()
  const now = useNow(60_000)
  // A provider whose every window reset since it was read keeps its ring, empty and dimmed.
  const glance = providers.flatMap((entry) => (entry.limits.length > 0 ? [{ entry, used: bindingLimit(entry.limits, now)?.used ?? null }] : []))
  if (glance.length === 0) return null
  return (
    <div role="group" aria-label="Plan usage" className="flex flex-col items-center">
      {glance.map(({ entry, used }) => {
        const name = PROVIDER_NAMES[entry.provider] ?? entry.provider
        return (
          <PopoverTrigger
            key={entry.provider}
            handle={usageCard}
            payload={entry.provider}
            openOnHover
            delay={80}
            closeDelay={100}
            render={
              <button
                type="button"
                aria-label={used === null ? `${name}: not read since reset` : `${name}: ${Math.round(100 - used)}% left`}
                data-testid={`rail-usage-${entry.provider}`}
                className="press relative inline-flex h-8 w-9 cursor-pointer items-center justify-center rounded-[10px] outline-hidden hover:bg-[var(--app-rail-hover)] focus-visible:ring-1 focus-visible:ring-ring data-popup-open:bg-[var(--app-rail-hover)]"
              />
            }
          >
            <UsageRing kind={entry.provider} left={used === null ? null : 100 - used} tone={limitTone(used)} stale={used === null || limitsStale(entry, now)} />
          </PopoverTrigger>
        )
      })}
      <Popover handle={usageCard} onOpenChange={(open) => { if (open) refreshUsageLimits() }}>
        {({ payload }) => (
          <PopoverPopup side="right" align="end" sideOffset={8} scrollable={false} className="w-72 font-system-ui">
            {payload && <UsageCard kind={payload} />}
          </PopoverPopup>
        )}
      </Popover>
    </div>
  )
}

function UsageRing({ kind, left, tone, stale }: { kind: ProviderKind; left: number | null; tone: ReturnType<typeof limitTone>; stale: boolean }) {
  return (
    <span className="rail-usage-ring" data-usage-tone={tone} data-stale={stale || undefined}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-7 -rotate-90" fill="none">
        <circle cx="12" cy="12" r="10.25" strokeWidth="2" className="rail-usage-track" />
        {left !== null && <circle cx="12" cy="12" r="10.25" strokeWidth="2" pathLength="100" strokeDasharray="100 100" strokeDashoffset={100 - left} strokeLinecap="round" className="rail-usage-arc" />}
      </svg>
      <ProviderMark kind={kind} size={12} className="absolute" />
    </span>
  )
}

function UsageCard({ kind }: { kind: ProviderKind }) {
  const entry = useProviderLimits(kind)
  const refreshing = useRefreshingLimits().includes(kind)
  const now = useNow(15_000)
  if (!entry) return null
  const reason = staleReason(entry, now)
  return (
    <div className="provider-usage-content flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ProviderMark kind={kind} size={14} />
        <PopoverTitle className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,13px)] font-medium leading-snug">{PROVIDER_NAMES[kind] ?? kind}</PopoverTitle>
        {entry.plan && <span className="shrink-0 text-muted-foreground">{entry.plan}</span>}
      </div>
      <div className="flex flex-col gap-3">
        {entry.limits.map((limit) => <LimitRow key={`${limit.window_minutes ?? ""}-${limit.name}`} limit={limit} kind={kind} now={now} />)}
      </div>
      <div className="flex flex-col gap-0.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground" aria-live="polite">
        <p>{freshness(entry, refreshing, now)}</p>
        {!refreshing && reason && <p>{reason}</p>}
      </div>
    </div>
  )
}

function LimitRow({ limit, kind, now }: { limit: ProviderLimits["limits"][number]; kind: ProviderKind; now: number }) {
  const used = limitUsed(limit, now)
  const name = limitLabel(limit, kind)
  const left = used === null ? null : 100 - used
  const pace = limitPace(limit, now)
  return (
    <div data-usage-tone={limitTone(used)}>
      <div className="mb-0.5 flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">{name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{limitLeftLabel(limit, now)}</span>
      </div>
      {left !== null && <LimitMeter left={left} pace={pace} label={`${name} left`} />}
      <div className="mt-0.5 flex items-baseline justify-between gap-3 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">
        <span className="min-w-0 truncate">{resetIn(limit.resets_at, now)}</span>
        {pace && <span className="shrink-0" data-pace-short={pace.short || undefined}>{pace.label}</span>}
      </div>
    </div>
  )
}

function freshness(entry: ProviderLimits, refreshing: boolean, now: number): string {
  if (refreshing) return "Updating…"
  const ago = updatedAgo(entry.updated_at, now)
  if (!ago) return ""
  return limitsStale(entry, now) ? `Last updated ${ago}` : `Updated ${ago}`
}
