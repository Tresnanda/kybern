import { launchHarnesses, harnessMarkGeometry } from '@/lib/launchHarnesses'
import { Icon } from '../icons.tsx'
import { PROVIDER_IMAGES, PROVIDER_VECTORS } from '../providerMarks.ts'
import { T } from '../transcript/glyphs.ts'
import { muted } from '../transcript/kit.tsx'
import { ProviderMark, useTheme } from '../ui.tsx'

const hasMark = (kind: string) => kind in PROVIDER_VECTORS || kind in PROVIDER_IMAGES

/**
 * The glyph in a launch group's 24 px badge: the logo of each distinct harness in the group, up to three, overlapping slightly.
 * A group on one harness shows that one logo at the usual size; a harness with no logo is the generic robot.
 */
export function HarnessMarks({ kinds }: { kinds: readonly (string | null | undefined)[] }) {
  const t = useTheme()
  const marks = launchHarnesses(kinds, hasMark)
  const { size, step, width } = harnessMarkGeometry(marks.length)
  return (
    <div style={{ position: 'relative', width, height: size, flexShrink: 0 }}>
      {marks.map((kind, i) => (
        <div key={kind ?? 'generic'} style={{ position: 'absolute', left: i * step, top: 0, width: size, height: size }}>
          {kind ? <ProviderMark kind={kind} size={size} /> : <Icon source={T.robot} size={size} color={muted(t)} />}
        </div>
      ))}
    </div>
  )
}
