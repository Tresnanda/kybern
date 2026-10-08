// FILE: ComposerStatusGlyph.tsx
// Purpose: One 16px glyph in the composer tray for what used to be two: the ring
// is the context window, the center dot is the prompt cache, and the arc takes a
// warning tone when context is high or the thread's account is nearly out of
// limit. Hover or press opens a popover with the prompt cache, the context
// window and the account's limits.
// Layer: Composer UI
// Exports: ComposerStatusGlyph

import { useEffect, useState } from "react"

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/kit/popover"
import { AccountMarkStack } from "@/components/kybern/accounts/AccountMark"
import { LimitMeter } from "@/components/kybern/LimitMeter"
import { accountsOfKind, cacheDotOpacity, cacheState, cacheValue, glyphAriaLabel, glyphTone, type CacheState } from "@/lib/accountUi"
import { CLI_ACCOUNT_NAME, CLI_INSTANCE, isCliInstance } from "@/lib/accounts"
import { useNow } from "@/lib/hooks"
import { contextUsage, bindingLimit, limitLabel, limitLeftLabel, limitPace, limitTone, limitUsed, resetIn } from "@/lib/providerUsage"
import { promptCacheRemainingMinutes, type PromptCacheWindow } from "@/lib/promptCache"
import type { ProviderInstance, ProviderUsage } from "@/protocol"
import { useAccounts } from "@/state/accounts"
import { loadAccountLimits, useAccountLimitEntries, useProviderLimits } from "@/state/usageLimits"

type Limits = NonNullable<ProviderUsage["limits"]>

const TONE_STROKE = { normal: "currentColor", warning: "var(--warning)", critical: "var(--destructive)" } as const

function UsageMeter({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="provider-usage-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  )
}

/** Re-render every 15s, but only while a warm cache has a minute count to keep right. */
function useWarmClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

export function ComposerStatusGlyph({
  usage,
  provider,
  promptCache,
  running,
}: {
  usage?: ProviderUsage
  provider: ProviderInstance | null
  promptCache?: { window: PromptCacheWindow; lastActivityAt: string }
  running?: boolean
}) {
  const kind = provider?.kind
  const instance = provider?.instance ?? CLI_INSTANCE
  const [open, setOpen] = useState(false)
  const accounts = useAccounts(kind)
  const own = kind ? accountsOfKind(accounts, kind) : []
  const multi = own.length > 1
  const account = own.find((entry) => entry.provider.instance === instance)
  const accountName = isCliInstance(instance) ? CLI_ACCOUNT_NAME : account?.name ?? "Account"
  // The default account's limits are the daemon's global entry, polled anyway.
  // Any other account is read only while the popover is open.
  const needsOwnRead = !!kind && multi && !!account && !account.is_default
  useEffect(() => {
    if (open && kind && needsOwnRead) loadAccountLimits({ instances: [{ kind, instance }] })
  }, [open, kind, instance, needsOwnRead])
  const entries = useAccountLimitEntries()
  const global = useProviderLimits(kind)
  const entry = entries.find((item) => item.provider === kind && item.instance === instance) ?? (!multi || account?.is_default ? global : undefined)
  const limits: Limits | undefined = entry?.limits.length ? entry.limits : multi ? undefined : usage?.limits

  const lastActivityAt = promptCache?.lastActivityAt
  const ttl = promptCache?.window.ttlMinutes
  const now = useWarmClock(!!promptCache && !running)
  const remaining = lastActivityAt && ttl ? promptCacheRemainingMinutes(lastActivityAt, ttl, now) : 0
  const cache: CacheState | null = promptCache ? cacheState(!!running, remaining) : null

  const context = contextUsage(usage?.context)
  const binding = limits ? bindingLimit(limits, now) : null
  const leftPercent = binding ? 100 - binding.used : null
  const tone = glyphTone(context?.percent ?? null, leftPercent)
  if (!context && !cache && !limits?.length) return null

  const label = glyphAriaLabel({
    contextPercent: context?.percent ?? null,
    cache,
    account: binding && leftPercent !== null ? { name: multi ? accountName : "Account", leftPercent, windowLabel: limitLabel(binding.limit, kind) } : null,
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        aria-label={label}
        data-usage-tone={tone}
        data-prompt-cache={cache ? cache.state : undefined}
        className="composer-status-glyph inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none">
          <g transform="rotate(-90 12 12)">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
            {context && <circle cx="12" cy="12" r="9" stroke={TONE_STROKE[tone]} strokeWidth="2.5" pathLength="100" strokeDasharray={`${context.percent} 100`} strokeLinecap="round" />}
          </g>
          {cache && cache.state !== "cold" && <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity={cacheDotOpacity(cache)} />}
        </svg>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" sideOffset={10} className="provider-usage-popover w-[19rem] max-w-[calc(100vw-2rem)] text-start [transition-property:scale,opacity] data-starting-style:blur-none">
        <GlyphPopover usage={usage} provider={provider} promptCache={promptCache} cache={cache} remaining={remaining} limits={limits} accountName={multi ? accountName : null} accountColor={account?.color ?? null} />
      </PopoverPopup>
    </Popover>
  )
}

function GlyphPopover({
  usage,
  provider,
  promptCache,
  cache,
  remaining,
  limits,
  accountName,
  accountColor,
}: {
  usage?: ProviderUsage
  provider: ProviderInstance | null
  promptCache?: { window: PromptCacheWindow; lastActivityAt: string }
  cache: CacheState | null
  remaining: number
  limits?: Limits
  accountName: string | null
  accountColor: string | null
}) {
  const now = useNow(60_000)
  const context = usage ? contextUsage(usage.context) : null
  const ctxTone = context && context.percent >= 95 ? "critical" : context && context.percent >= 80 ? "warning" : "normal"
  const detail = !promptCache || !cache
    ? null
    : cache.state === "active"
      ? `${promptCache.window.providerLabel} is actively using this conversation.`
      : cache.state === "warm"
        ? `About ${remaining} minute${remaining === 1 ? "" : "s"} remain in the documented ${promptCache.window.ttlMinutes}-minute warm window.`
        : `The documented ${promptCache.window.ttlMinutes}-minute warm window has elapsed.`
  return (
    <div className="provider-usage-content">
      {cache && detail && (
        <section className="mb-6" aria-label="Prompt cache">
          <div className="provider-usage-heading !mb-2">
            <PopoverTitle className="text-[length:var(--app-font-size-ui,12px)] font-medium leading-normal text-muted-foreground">Prompt cache</PopoverTitle>
            <span className="text-[length:var(--app-font-size-ui,12px)] font-medium tabular-nums">{cacheValue(cache)}</span>
          </div>
          <p className="provider-usage-caption !mt-0">{detail} Actual retention may be longer.</p>
        </section>
      )}
      <section data-usage-tone={ctxTone}>
        <div className="provider-usage-heading">
          <h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium leading-normal text-muted-foreground">Context window</h3>
          <span className="provider-usage-value">{context ? `${Math.round(context.percent)}%` : "—"}</span>
        </div>
        {context ? <>
          <UsageMeter percent={context.percent} label="Context used" />
          <p className="provider-usage-caption tabular-nums"><span className="text-foreground">{context.used.toLocaleString()}</span> of {context.window.toLocaleString()} tokens</p>
        </> : <p className="provider-usage-caption">Context usage hasn’t been reported yet.</p>}
      </section>
      <section className="provider-usage-limits" aria-label={accountName ? `Account limits — ${accountName}` : "Account limits"}>
        <h3 className="provider-usage-section-label flex items-center gap-1.5">
          {accountName && provider ? <>Account limits — <AccountMarkStack kind={provider.kind} color={accountColor} size={12} /><span className="min-w-0 truncate text-foreground"><bdi>{accountName}</bdi></span></> : "Account limits"}
        </h3>
        {limits?.length ? limits.map((limit, index) => {
          const percent = limitUsed(limit, now)
          const name = limitLabel(limit, provider?.kind)
          const pace = limitPace(limit, now)
          return <div key={`${limit.name}-${index}`} className="provider-usage-limit" data-usage-tone={limitTone(percent)}>
            <div className="provider-usage-limit-heading"><span>{name}</span><span className="tabular-nums text-muted-foreground">{limitLeftLabel(limit, now)}</span></div>
            {percent !== null && <LimitMeter left={100 - percent} pace={pace} label={`${name} left`} />}
            <p className="provider-usage-caption flex justify-between gap-3 tabular-nums"><span>{resetIn(limit.resets_at, now)}</span>{pace && <span data-pace-short={pace.short || undefined}>{pace.label}</span>}</p>
          </div>
        }) : <p className="provider-usage-caption">Account limits haven’t been reported yet.</p>}
      </section>
      <p className="provider-usage-note">Context can decrease after compaction.</p>
    </div>
  )
}
