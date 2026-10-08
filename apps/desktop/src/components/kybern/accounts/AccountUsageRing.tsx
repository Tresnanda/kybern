import { limitTone } from "@/lib/providerUsage"

/** A small ring filled with what is left of a limit, in the tone of how close it is to running out. */
export function AccountUsageRing({ left, size = 20, className }: { left: number; size?: number; className?: string }) {
  const tone = limitTone(100 - left)
  return (
    <span className={`rail-usage-ring ${className ?? ""}`} data-usage-tone={tone} style={{ width: size, height: size }}>
      <svg aria-hidden viewBox="0 0 24 24" className="-rotate-90" width={size} height={size} fill="none">
        <circle cx="12" cy="12" r="10.25" strokeWidth="2.5" className="rail-usage-track" />
        <circle cx="12" cy="12" r="10.25" strokeWidth="2.5" pathLength="100" strokeDasharray="100 100" strokeDashoffset={100 - left} strokeLinecap="round" className="rail-usage-arc" />
      </svg>
    </span>
  )
}
