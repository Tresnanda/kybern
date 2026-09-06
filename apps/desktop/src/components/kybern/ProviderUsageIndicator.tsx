import type { ProviderUsage } from "@/protocol"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"

export function ProviderUsageIndicator({ usage }: { usage?: ProviderUsage }) {
  const context = usage?.context
  const percent = context && context.window_tokens > 0 ? Math.min(100, Math.max(0, context.used_tokens / context.window_tokens * 100)) : null
  const label = percent === null ? "Context usage unavailable" : `${Math.round(percent)}% of context used`
  return (
    <Tooltip>
      <TooltipTrigger aria-label={label} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2">
        <svg aria-hidden viewBox="0 0 24 24" className="size-4 -rotate-90" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          {percent !== null && <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${percent} 100`} strokeLinecap="round" />}
        </svg>
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        <div className="space-y-3 py-1 text-xs tabular-nums">
          <div><div className="font-medium">{label}</div><div className="mt-1 text-muted-foreground">{context ? `${context.used_tokens.toLocaleString()} / ${context.window_tokens.toLocaleString()} tokens` : "This harness has not reported its context window."}</div></div>
          {usage?.limits?.map((limit) => <div key={limit.name}>
            <div className="flex items-center justify-between gap-6"><span>{limit.window_minutes === 300 ? "5-hour" : limit.window_minutes === 10080 ? "Weekly" : limit.name} limit</span><span>{Math.round(limit.used_percent)}% used</span></div>
            <div className="mt-1 text-muted-foreground">{limit.resets_at ? `Resets ${new Date(limit.resets_at * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Reset time unavailable"}</div>
          </div>)}
          {!usage?.limits?.length && <div className="text-muted-foreground">Account limits have not been reported.</div>}
          <div className="text-muted-foreground">Last reported by the harness. Context can shrink after compaction.</div>
        </div>
      </TooltipPopup>
    </Tooltip>
  )
}
