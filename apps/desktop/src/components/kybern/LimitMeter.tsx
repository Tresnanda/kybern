import type { LimitPace } from "@/lib/providerUsage"

/**
 * What is left of a plan limit, as a bar that drains as it is used. The tick
 * marks where even spending across the window would leave it: fill past the
 * tick is reserve, fill short of it means usage is running ahead of time.
 */
export function LimitMeter({ left, pace, label }: { left: number; pace: LimitPace | null; label: string }) {
  return (
    <div className="limit-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left)}>
      <div className="limit-meter-track"><span style={{ transform: `scaleX(${left / 100})` }} /></div>
      {pace && <span className="limit-meter-pace" aria-hidden style={{ insetInlineStart: `${pace.evenLeft}%` }} />}
    </div>
  )
}
