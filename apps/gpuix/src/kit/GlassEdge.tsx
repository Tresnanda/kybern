import { withAlpha } from './Switch.tsx'

/**
 * The 1px light catch along a glass surface's top edge (Zeron `glass.rs` inset highlight; GPUIX has no inset shadow).
 * Place as the first child of a `position: relative` surface with a 1px border. Paints nothing when `color` is empty,
 * which is what every highlight token is outside whole-window glass.
 *
 * GPUIX gradients take two stops, so the tapered ends are two short gradients with a solid run between them.
 */
export function GlassEdge({ radius, color }: { radius: number; color: string }) {
  if (!color) return null
  const inset = Math.max(4, radius * 0.5)
  const taper = Math.min(14, Math.max(3, radius * 0.4))
  const clear = withAlpha(color, 0)
  const ramp = (from: string, to: string) => ({ width: taper, height: 1, flexShrink: 0, background: { type: 'linear-gradient' as const, angle: 90, stops: [{ color: from, position: 0 }, { color: to, position: 1 }] as [{ color: string; position: number }, { color: string; position: number }] } })
  return <div style={{ position: 'absolute', top: 0, left: inset, right: inset, height: 1, display: 'flex', pointerEvents: 'none' }}>
    <div style={ramp(clear, color)} />
    <div style={{ flexGrow: 1, height: 1, backgroundColor: color }} />
    <div style={ramp(color, clear)} />
  </div>
}
