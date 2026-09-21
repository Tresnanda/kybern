import { useEffect, useState } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ClockIcon } from "@/lib/kit/icons"
import { promptCacheRemainingMinutes, type PromptCacheWindow } from "@/lib/promptCache"
import { cn } from "@/lib/utils"

export function PromptCacheIndicator({
  cacheWindow,
  lastActivityAt,
  running,
}: {
  cacheWindow: PromptCacheWindow
  lastActivityAt: string
  running?: boolean
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (running) return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [running])

  const remaining = promptCacheRemainingMinutes(lastActivityAt, cacheWindow.ttlMinutes, now)
  const warm = running || remaining > 0
  const value = running ? "Active" : warm ? `${remaining}m` : "Cold"
  const detail = running
    ? `${cacheWindow.providerLabel} is actively using this conversation.`
    : warm
      ? `About ${remaining} minute${remaining === 1 ? "" : "s"} remain in the documented ${cacheWindow.ttlMinutes}-minute warm window.`
      : `The documented ${cacheWindow.ttlMinutes}-minute warm window has elapsed.`
  const label = `Prompt cache: ${value}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-prompt-cache={warm ? running ? "active" : "warm" : "cold"}
            aria-label={label}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums",
              "text-muted-foreground transition-[color,opacity] duration-150",
              warm ? "opacity-85" : "opacity-55",
            )}
          />
        }
      >
        <ClockIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="leading-none">{value}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" sideOffset={6} variant="picker">
        <span className="block max-w-64 px-1 py-0.5">
          <span className="block font-medium text-foreground">{label}</span>
          <span className="mt-0.5 block text-muted-foreground">{detail} Actual retention may be longer.</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  )
}
