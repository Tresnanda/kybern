import { launchHarnesses, harnessMarkGeometry } from '@/lib/launchHarnesses'
import { Icon } from '../icons.tsx'
import { PROVIDER_IMAGES, PROVIDER_VECTORS } from '../providerMarks.ts'
import { over, stack } from '../theme.ts'
import { T } from '../transcript/glyphs.ts'
import { muted } from '../transcript/kit.tsx'
import { ink, ProviderMark, useMaterial, useTheme } from '../ui.tsx'

const hasMark = (kind: string) => kind in PROVIDER_VECTORS || kind in PROVIDER_IMAGES

/** The badge slot every launch group's glyph fills; the tree line hangs from its centre (`LAUNCH_STEM` in `transcript/rows.tsx`). */
const SLOT = 24

/**
 * A delegated-agents group's 24 px badge: the logo of each distinct harness in the group. One harness keeps the badge's own
 * circle with its 13 px logo (a harness with no logo is the generic robot). Two are an avatar stack of 16 px plates that fills
 * the slot exactly, so it is centred on the same axis as the line below it: the first harness in front, each plate the neutral
 * ink step of the update card's icon tiles, ringed in the conversation's own fill so the front plate cuts a clean edge into the
 * one behind. A third harness is not shown.
 */
export function HarnessMarks({ kinds }: { kinds: readonly (string | null | undefined)[] }) {
  const t = useTheme()
  const fills = useMaterial()
  const marks = launchHarnesses(kinds, hasMark)
  const g = harnessMarkGeometry(marks.length)
  const mark = (kind: string | null, size: number) => kind ? <ProviderMark kind={kind} size={size} /> : <Icon source={T.robot} size={size} color={muted(t)} />
  if (marks.length <= 1) {
    return (
      <div style={{ display: 'flex', width: SLOT, height: SLOT, borderRadius: SLOT / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: t.buttonSecondary, flexShrink: 0 }}>
        {mark(marks[0] ?? null, g.logo)}
      </div>
    )
  }
  // The conversation card's fill, made opaque: on whole-window glass that card is a translucent coat, so the ring takes the
  // coat over the frame over the theme's surface, the nearest single colour to what shows through.
  const behind = over(stack(fills.content, fills.frame), t.surface)
  const plate = over(ink(t, t.variant === 'dark' ? 0.07 : 0.05), behind)
  const centred = (g.plate - g.logo) / 2
  // The front plate and its ring cover the left of the plate behind; that logo moves right, a pixel inside its own edge.
  const behindLeft = g.plate - 1 - g.logo
  const outer = g.plate + g.ring * 2
  const top = (SLOT - g.plate) / 2
  return (
    <div style={{ position: 'relative', width: SLOT, height: SLOT, flexShrink: 0 }}>
      {/* Later siblings paint on top, so the stack is laid out from the back: the first harness is last, in front. */}
      {marks.map((kind, i) => ({ kind, i })).reverse().map(({ kind, i }) => (
        <div key={kind ?? 'generic'}
          style={{ position: 'absolute', left: i * g.step - g.ring, top: top - g.ring, width: outer, height: outer, borderRadius: outer / 2, backgroundColor: behind }}>
          <div style={{ position: 'absolute', left: g.ring, top: g.ring, width: g.plate, height: g.plate, borderRadius: g.plate / 2, backgroundColor: plate }}>
            <div style={{ position: 'absolute', left: i === 0 ? centred : behindLeft, top: centred, width: g.logo, height: g.logo }}>{mark(kind, g.logo)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
