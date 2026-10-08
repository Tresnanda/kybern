import { useState } from "react"

import { BotIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"

// A broken URL is remembered so a long list never retries it per row.
const failed = new Set<string>()

export function PrAvatar({
  login,
  url,
  bot,
  size,
  className,
}: {
  login: string
  url?: string | null
  bot?: boolean
  size: 16 | 20
  className?: string
}) {
  const [, rerender] = useState(0)
  const box = { width: size, height: size }
  const base = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
    className
  )
  if (bot)
    return (
      <span
        aria-hidden
        style={box}
        className={cn(base, "bg-[var(--color-background-button-secondary)] text-muted-foreground")}
      >
        <BotIcon style={{ width: size * 0.65, height: size * 0.65 }} />
      </span>
    )
  if (url && !failed.has(url))
    return (
      <img
        src={url}
        alt=""
        {...box}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={base}
        onError={() => {
          failed.add(url)
          rerender((n) => n + 1)
        }}
      />
    )
  const initial = [...login.trim()][0]?.toUpperCase() ?? "?"
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: size * 0.55 }}
      className={cn(base, "bg-[var(--color-background-button-secondary)] leading-none font-semibold text-muted-foreground")}
    >
      {initial}
    </span>
  )
}
