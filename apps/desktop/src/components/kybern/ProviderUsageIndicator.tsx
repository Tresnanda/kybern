import type { ProviderKind, ProviderUsage } from "@/protocol"
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/kit/popover"
import { LimitMeter } from "@/components/kybern/LimitMeter"
import { useNow } from "@/lib/hooks"
import { contextUsage, limitLabel, limitPace, limitTone, reportedPercent, resetIn } from "@/lib/providerUsage"
import { useProviderLimits } from "@/state/usageLimits"

function UsageMeter({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="provider-usage-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  )
}

export function ProviderUsageIndicator({ usage, provider }: { usage?: ProviderUsage; provider?: ProviderKind }) {
  const context = contextUsage(usage?.context)
  // Limits belong to the account: use the daemon's live values, not the last
  // ones this thread happened to report. The thread's copy covers older daemons.
  const account = useProviderLimits(provider)
  const limits = account?.limits.length ? account.limits : usage?.limits
  const now = useNow(60_000)
  const label = context ? `${Math.round(context.percent)}% of context used` : "Context usage unavailable"
  const tone = context && context.percent >= 95 ? "critical" : context && context.percent >= 80 ? "warning" : "normal"
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={250} closeDelay={100} aria-label={`Usage: ${label}`} data-usage-tone={tone} className="provider-usage-trigger inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-popup-open:bg-muted data-popup-open:text-foreground">
        <svg aria-hidden viewBox="0 0 24 24" className="size-4 -rotate-90" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
          {context && <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" pathLength="100" strokeDasharray={`${context.percent} 100`} strokeLinecap="round" />}
        </svg>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" sideOffset={10} className="provider-usage-popover w-[19rem] max-w-[calc(100vw-2rem)] text-start [transition-property:scale,opacity] data-starting-style:blur-none">
        <div className="provider-usage-content">
          <section data-usage-tone={tone}>
            <div className="provider-usage-heading">
              <PopoverTitle className="text-[length:var(--app-font-size-ui,12px)] font-medium leading-normal text-muted-foreground">Context window</PopoverTitle>
              <span className="provider-usage-value">{context ? `${Math.round(context.percent)}%` : "—"}</span>
            </div>
            {context ? <>
              <UsageMeter percent={context.percent} label="Context used" />
              <p className="provider-usage-caption tabular-nums"><span className="text-foreground">{context.used.toLocaleString()}</span> of {context.window.toLocaleString()} tokens</p>
            </> : <p className="provider-usage-caption">Context usage hasn’t been reported yet.</p>}
          </section>
          <section className="provider-usage-limits" aria-label="Account limits">
            <h3 className="provider-usage-section-label">Account limits</h3>
            {limits?.length ? limits.map((limit, index) => {
              const percent = reportedPercent(limit.used_percent)
              const name = limitLabel(limit, provider)
              const pace = limitPace(limit, now)
              return <div key={`${limit.name}-${index}`} className="provider-usage-limit" data-usage-tone={limitTone(percent)}>
                <div className="provider-usage-limit-heading"><span>{name}</span><span className="tabular-nums text-muted-foreground">{percent === null ? "Unavailable" : `${Math.round(100 - percent)}% left`}</span></div>
                {percent !== null && <LimitMeter left={100 - percent} pace={pace} label={`${name} left`} />}
                <p className="provider-usage-caption flex justify-between gap-3 tabular-nums"><span>{resetIn(limit.resets_at, now)}</span>{pace && <span data-pace-short={pace.short || undefined}>{pace.label}</span>}</p>
              </div>
            }) : <p className="provider-usage-caption">Account limits haven’t been reported yet.</p>}
          </section>
          <p className="provider-usage-note">Context can decrease after compaction.</p>
        </div>
      </PopoverPopup>
    </Popover>
  )
}
