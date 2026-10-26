// A Finder drag over a drop target: the desktop sets the card's border to `--color-border-focus` on `dragover` and
// back on `dragleave`/`drop`, eased by the card's `transition-colors duration-200` (Tailwind's default curve,
// cubic-bezier(0.4, 0, 0.2, 1); not a movement, so Reduce Motion keeps it). GPUIX lays a focus-coloured ring over the
// card's own border and cross-fades it with the paint-only subtree opacity (`native/upstream/packages/native/src/subtree_transform.rs`):
// no render or layout per frame. Drive `over` from the native `onFileDragChange` event.
import { PATCHED_NATIVE } from '../native/local-build.ts'

/** `transition-colors duration-200`: 200 ms on Tailwind's default ease. */
export const DROP_FADE = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] }

export function DropHighlight({ over, radius, color, width = 1 }: { over: boolean; radius: number; color: string; width?: number }) {
  if (!PATCHED_NATIVE && !over) return null
  return (
    <div
      testId="drop-highlight"
      paintTransform={PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: over ? 1 : 0 }, transition: DROP_FADE } : undefined}
      style={{ position: 'absolute', left: -width, top: -width, right: -width, bottom: -width, borderRadius: radius, borderWidth: width, borderColor: color, pointerEvents: 'none' }}
    />
  )
}
