// Shared primitives and the active theme. Sizes mirror the desktop kit: 28px
// rows and controls with a 10px radius, 14px UI text, SF Pro for UI and
// JetBrains Mono for code.
import { spawnSync } from 'node:child_process'
import { createContext, useContext, type ReactNode } from 'react'
import type { StyleDesc } from '@gpuix/react'
import { useAppearance } from './settings/appearance.ts'
import { useSyncWindowAppearance, useSystemVariant } from './shell/appearance.ts'
import { FONT_UI, THEMES, type Theme } from './theme.ts'
import { Icon, type IconName } from './icons.tsx'
import { PROVIDER_IMAGES, PROVIDER_VECTORS } from './providerMarks.ts'

function systemVariant(): 'dark' | 'light' {
  const forced = process.env.KYBERN_APPEARANCE
  if (forced === 'dark' || forced === 'light') return forced
  const r = spawnSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { encoding: 'utf8' })
  return r.stdout?.trim() === 'Dark' ? 'dark' : 'light'
}

function systemReducedMotion(): boolean {
  if (process.env.KYBERN_REDUCED_MOTION) return process.env.KYBERN_REDUCED_MOTION === '1'
  const r = spawnSync('defaults', ['read', 'com.apple.universalaccess', 'reduceMotion'], { encoding: 'utf8' })
  return r.stdout?.trim() === '1'
}

export const VARIANT = systemVariant()
export const REDUCED_MOTION = systemReducedMotion()
/** Strong ease-out for UI entering or moving (Emil Kowalski's `--ease-out`). */
export const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]

const ThemeContext = createContext<Theme>(THEMES[VARIANT])
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const prefs = useAppearance()
  // "System" follows macOS live (`shell/appearance.ts`); KYBERN_APPEARANCE pins a variant.
  const system = useSystemVariant(VARIANT)
  const forced = process.env.KYBERN_APPEARANCE === 'light' || process.env.KYBERN_APPEARANCE === 'dark'
  const variant = forced ? VARIANT : prefs.theme === 'system' ? system : prefs.theme
  useSyncWindowAppearance(variant, prefs.translucent)
  return <ThemeContext.Provider value={THEMES[variant]}>{children}</ThemeContext.Provider>
}
export const useTheme = () => useContext(ThemeContext)

/** The ink colour at an opacity, like Tailwind's `text-foreground/58`. */
export function ink(t: Theme, alpha: number): string {
  const [r, g, b] = t.variant === 'dark' ? [252, 252, 252] : [13, 13, 13]
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function Label({
  children,
  color,
  size = 14,
  lineHeight,
  weight,
  font = FONT_UI,
  truncate,
  style,
}: {
  children: ReactNode
  color: string
  size?: number
  lineHeight?: number
  weight?: number
  font?: string
  truncate?: boolean
  style?: StyleDesc
}) {
  return (
    <text
      style={{
        color,
        fontSize: size,
        fontFamily: font,
        ...(lineHeight ? { lineHeight } : {}),
        ...(weight ? { fontWeight: weight } : {}),
        ...(truncate
          ? { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', minWidth: 0, flexShrink: 1 }
          : {}),
        ...style,
      }}
    >
      {children}
    </text>
  )
}

/** Square chrome button: 28px, radius 10, 16px glyph (`views/chrome.tsx`). */
export function ChromeButton({
  icon,
  onClick,
  size = 28,
  glyph = 16,
  color,
  testId,
}: {
  icon: IconName
  onClick?: () => void
  size?: number
  glyph?: number
  color?: string
  testId?: string
}) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 10,
        flexShrink: 0,
        cursor: onClick ? 'pointer' : 'default',
        hover: { backgroundColor: t.buttonTertiaryHover },
        active: { backgroundColor: t.buttonSecondaryHover },
      }}
    >
      <Icon name={icon} size={glyph} color={color ?? t.iconPrimary} />
    </div>
  )
}

export function ProviderMark({ kind, size = 14, tone = 'default' }: { kind: string; size?: number; tone?: 'default' | 'header' }) {
  const t = useTheme()
  const style = { width: size, height: size, flexShrink: 0, pointerEvents: 'none' as const }
  if (kind === 'opencode') return <img src={PROVIDER_IMAGES.opencode[t.variant]} objectFit="contain" style={style} />
  if (kind === 'omp' || kind === 'antigravity') return <img src={PROVIDER_IMAGES[kind]} objectFit="contain" style={style} />
  const source = PROVIDER_VECTORS[kind]
  if (source) return <svg source={source} style={{ ...style, color: kind === 'claude-code' || kind === 'claudeAgent' ? '#D97757' : kind === 'codex' && tone === 'header' ? t.textSecondary : t.text, opacity: kind === 'codex' && tone === 'header' ? 0.85 : 1 }} />
  return <Icon name="bot" size={size} color={t.iconSecondary} />
}

/** The Kybern mark from `components/kybern/bits.tsx`. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 504 315"><path fill="#000" transform="matrix(0.99941953434 0 0 1.115949597003 0 0)" d="M423.91998 0.59084c105.84003 15.68001 112.56 281.67997-12.31997 281.67997-62.72004 0-101.92002-73.35997-136.64002-92.39998-10.08002-5.04-21.28-7.27999-33.04001-4.48001-34.15999 7.84003-63.27998 67.76001-118.15999 90.15996-8.96 3.36005-20.16 6.72003-33.03999 6.16004-54.88 1.11999-90.72-66.07998-90.72-141.11998 0-75.04001 36.4-142.23999 90.72-140.56 60.47998 0.56 91.84 53.76001 127.12 81.76001 13.43997 10.63998 23.51999 15.67998 37.51999 15.11999 40.88-1.68001 62.16-52.08002 112.55999-82.88 13.44001-7.84 33.04001-15.12 56-13.44z"/></svg>`

/** `claude-opus-5-5` → `Opus 5.5`; other ids are shown as the harness reports them. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'Default model'
  const claude = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  return model
    .split('-')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}

export function clockDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

export function clockTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
