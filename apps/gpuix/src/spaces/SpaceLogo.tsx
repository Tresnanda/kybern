// A space's tile (`docs/specs/spaces.md` §7.4) at 16, 32 or 44 px: initials, a glyph on the swatch,
// or the daemon's image with the swatch behind it while it loads.
import type { Space } from '../../../../packages/kybern-client/src/types.ts'
import { spaceInitials } from '../../../../packages/kybern-client/src/spaces.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { FONT_UI } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { SWATCHES } from './colors.ts'
import { SPACE_GLYPHS } from './glyphs.ts'
import { useSpaceImage } from './images.ts'

export type TileSize = 16 | 32 | 44

const RADIUS: Record<TileSize, number> = { 16: 5, 32: 9, 44: 12 }
const STAR = N.arrowUp

/** The tile's corner radius, shared with rings drawn around it. */
export const tileRadius = (size: TileSize) => RADIUS[size]

/** Initials type size: 15 for one character and 13 for two at 32 px, scaled ×1.375 at 44 and ×0.5 at 16 (min 9). */
export function initialsSize(text: string, size: TileSize): number {
  const base = [...text].length > 1 ? 13 : 15
  const scaled = size === 44 ? base * 1.375 : size === 16 ? base * 0.5 : base
  return Math.max(9, scaled)
}

export function SpaceLogo({ space, size, previewImage }: { space: Pick<Space, 'name' | 'color' | 'logo'>; size: TileSize; /** A `data:` URI shown instead of the stored logo (the editor's live preview). */ previewImage?: string | null }) {
  const t = useTheme()
  const swatch = SWATCHES[space.color]
  const stored = useSpaceImage(space.logo.kind === 'image' ? space.logo.asset_id : null)
  const image = previewImage ?? stored
  const initials = spaceInitials(space.name)
  const icon = space.logo.kind === 'icon' ? SPACE_GLYPHS[space.logo.icon] : undefined
  const glyphSize = size === 32 ? 18 : size === 44 ? 24 : 10
  const showImage = (space.logo.kind === 'image' || previewImage) && image
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: RADIUS[size],
        backgroundColor: swatch.fill,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {showImage ? (
        <>
          <img src={image} alt="" objectFit="cover" style={{ width: size, height: size }} />
          {/* A hairline keeps light images from melting into a light rail. */}
          <div style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, borderRadius: RADIUS[size], borderWidth: 1, borderColor: t.cardEdge }} />
        </>
      ) : icon ? (
        <Icon source={icon} size={glyphSize} color={swatch.fg} />
      ) : initials ? (
        <Label color={swatch.fg} font={FONT_UI} weight={600} size={initialsSize(initials, size)} lineHeight={initialsSize(initials, size) + 2}>{initials}</Label>
      ) : (
        <Icon source={SPACE_GLYPHS.star ?? STAR} size={glyphSize} color={swatch.fg} />
      )}
    </div>
  )
}
