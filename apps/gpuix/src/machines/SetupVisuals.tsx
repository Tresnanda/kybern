import { AlertCircleIcon, AppleIcon, ComputerIcon, Download04Icon, PauseCircleIcon, WindowsNewIcon } from '@hugeicons/core-free-icons'
import { glyph, Icon, ICONS } from '../icons.tsx'
import { Badge } from '../kit/Badge.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'

export const SETUP_ICONS = {
  computer: glyph(ComputerIcon), apple: glyph(AppleIcon), windows: glyph(WindowsNewIcon),
  download: glyph(Download04Icon), attention: glyph(AlertCircleIcon), pause: glyph(PauseCircleIcon),
}

/** Platform marks use known metadata; an unknown host keeps the neutral computer. */
export function MachineSymbol({ os, size = 36 }: { os?: string; size?: number }) {
  const t = useTheme()
  const source = os === 'linux' ? ICONS.console : os === 'windows' ? SETUP_ICONS.windows : os === 'darwin' || os === 'macos' ? SETUP_ICONS.apple : SETUP_ICONS.computer
  return <div aria-hidden style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: t.hover }}>
    <Icon source={source} size={size * .58} color={t.iconSecondary} />
  </div>
}

export function SetupStatus({ kind, text }: { kind: 'ready' | 'error' | 'off' | 'install' | 'waiting'; text: string }) {
  const icon = kind === 'ready' ? N.circleCheck : kind === 'error' ? SETUP_ICONS.attention : kind === 'off' ? SETUP_ICONS.pause : kind === 'install' ? SETUP_ICONS.download : ICONS.clock
  return <Badge size="lg" icon={icon} variant={kind === 'ready' ? 'success' : kind === 'error' ? 'error' : kind === 'install' ? 'info' : 'outline'}>{text}</Badge>
}

/** A compact source → destination picture gives the setup sheet a clear reading order. */
export function SetupRoute({ source, destination }: { source: string; destination: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8, paddingBottom: 8 }}>
    <Icon name="folder" size={28} color={t.link} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
      <Label color={t.textTertiary} size={12} lineHeight={18}>From</Label>
      <Label color={t.text} size={13} lineHeight={20} weight={500}>{source}</Label>
    </div>
    <Icon name="arrowRight" size={18} color={t.iconTertiary} />
    <MachineSymbol />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
      <Label color={t.textTertiary} size={12} lineHeight={18}>To</Label>
      <Label color={t.text} size={13} lineHeight={20} weight={500}>{destination}</Label>
    </div>
  </div>
}
