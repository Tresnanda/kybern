// Marks that tell one account of an agent apart from another (`components/kybern/accounts/AccountMark.tsx`):
// the colour dot, the agent mark with its dot, the avatar tile, the usage ring and the limit meter.
// The CLI account and any account without a known colour never show a dot.
import { isAccountColor, isCliInstance, type AccountColor } from '../shared/lib/accounts.ts'
import type { LimitPace } from '../shared/lib/providerUsage.ts'
import { limitTone } from '../shared/lib/providerUsage.ts'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { useState } from 'react'
import { MeterFill } from '../motion/Meter.tsx'
import { ink, ProviderMark, useTheme } from '../ui.tsx'
import { useBoxWidth } from './useBoxWidth.ts'
import type { Theme } from '../theme.ts'
import { ringValue } from '../motion/success.ts'

/** `--account-*` (`kit.css:3365-3384`), light then dark. */
const ACCOUNT_RGB: Record<AccountColor, readonly [string, string]> = {
  blue: ['1, 105, 204', '51, 134, 214'],
  green: ['0, 162, 64', '47, 191, 99'],
  purple: ['117, 30, 217', '176, 109, 255'],
  pink: ['194, 48, 122', '232, 106, 166'],
  teal: ['15, 143, 134', '51, 191, 179'],
  amber: ['217, 119, 6', '245, 180, 74'],
}

/** The account colour as an rgba string, or null when the key is unknown. */
export function accountColor(t: Theme, color: string | null | undefined, alpha = 1): string | null {
  return isAccountColor(color) ? `rgba(${ACCOUNT_RGB[color][t.variant === 'dark' ? 1 : 0]}, ${alpha})` : null
}

/** The account's colour as a small dot. It never sits on an agent mark: beside a mark use `AccountMarkStack`. */
export function AccountDot({ color, size = 6 }: { color?: string | null; size?: number }) {
  const t = useTheme()
  const fill = accountColor(t, color)
  if (!fill) return null
  return <div style={{ width: size, height: size, flexShrink: 0, borderRadius: size / 2, backgroundColor: fill, pointerEvents: 'none' }} />
}

/** The agent mark with the account's dot beside it at the top-right, never on the mark. */
export function AccountMarkStack({ kind, color, size = 14 }: { kind: ProviderKind; color?: string | null; size?: number }) {
  return <div style={{ display: 'flex', alignItems: 'flex-start', flexShrink: 0, pointerEvents: 'none' }}><ProviderMark kind={kind} size={size} />{isAccountColor(color) && <div style={{ marginLeft: 1 }}><AccountDot color={color} /></div>}</div>
}

/** A rounded tile tinted with the account colour, with the agent mark in its centre. */
export function AccountAvatar({ kind, color, instance, size = 28 }: { kind: ProviderKind; color?: string | null; instance?: string | null; size?: 20 | 28 | 32 }) {
  const t = useTheme()
  const cli = isCliInstance(instance)
  const tint = cli ? null : accountColor(t, color, 0.14)
  const edge = cli ? null : accountColor(t, color, 0.4)
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0, borderRadius: size === 20 ? 6 : 8, borderWidth: 1, borderColor: edge ?? t.border, backgroundColor: tint ?? t.buttonSecondary, pointerEvents: 'none' }}><ProviderMark kind={kind} size={Math.round(size * 0.5)} /></div>
}

const R = 10.25
function ringTrack(stroke: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="${R}" stroke="#000" stroke-width="${stroke}"/></svg>`
}

export function toneColor(t: Theme, tone: ReturnType<typeof limitTone>) {
  return tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : ink(t, 0.62)
}

/** A small ring filled with what is left of a limit, in the tone of how close it is to running out (`AccountUsageRing`). */
export function AccountUsageRing({ left, size = 20 }: { left: number; size?: number }) {
  const t = useTheme()
  // A refreshed limit eases from the old value to the new one (native ring, N2); it mounts at its value.
  const arc = ringValue({ size: 24, radius: R, strokeWidth: 2.5, fraction: Math.max(0, Math.min(100, left)) / 100 })
  return <div style={{ position: 'relative', width: size, height: size, flexShrink: 0, pointerEvents: 'none' }}><svg source={ringTrack(2.5)} style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, color: ink(t, 0.12), pointerEvents: 'none' }} />{left > 0 && <svg source={arc.source} {...(arc.paintAnimation ? { paintAnimation: arc.paintAnimation } : {})} style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, color: toneColor(t, limitTone(100 - left)), pointerEvents: 'none' }} />}</div>
}

/**
 * The fill of a limit bar (`.limit-meter-track > span`, width 400 ms `--ease-out`): a paint-only `MeterFill` once the track's width is
 * known, so a refreshed value slides to its new length without a layout. Until then (one frame) a static fill of the same length stands in,
 * so a bar never shows empty; with `play` the bar instead starts empty and grows in when it first mounts (fresh content only).
 */
export function LimitFill({ left, color, play = false, height = 4, radius = 2 }: { left: number; color: string; play?: boolean; height?: number; radius?: number }) {
  const [ref, width] = useBoxWidth()
  const [grow] = useState(play)
  const value = Math.max(0, Math.min(100, left))
  return <div ref={ref} style={{ display: 'flex', width: '100%', height, flexShrink: 0 }}>
    {width > 0 ? <MeterFill value={value / 100} length={width} thickness={height} radius={radius} color={color} play={grow} /> : !grow && <div style={{ width: `${value}%`, height, borderRadius: radius, backgroundColor: color }} />}
  </div>
}

/**
 * What is left of a plan limit, as a bar that drains as it is used (`LimitMeter`). The tick marks
 * where even spending across the window would leave it: fill past the tick is reserve, fill short of
 * it means usage is running ahead of time.
 */
export function LimitMeter({ left, pace, label }: { left: number; pace: LimitPace | null; label: string }) {
  const t = useTheme()
  const tone = limitTone(100 - left)
  return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left)} style={{ position: 'relative', width: '100%', paddingTop: 3, paddingBottom: 3 }}>
    <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: ink(t, 0.1) }}><LimitFill left={left} color={tone === 'critical' ? t.v('--destructive') : tone === 'warning' ? t.warning : ink(t, 0.65)} /></div>
    {pace && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pace.evenLeft}%`, pointerEvents: 'none' }}><div style={{ position: 'absolute', right: -0.75, top: 0, bottom: 0, width: 1.5, borderRadius: 1, backgroundColor: ink(t, 0.45), pointerEvents: 'none' }} /></div>}
  </div>
}

