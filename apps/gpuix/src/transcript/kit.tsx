import { transcriptMarkdownStyle } from '../native/markdown.ts'
import { keyboardAnswer } from '../requests/Panel.tsx'
// Small transcript primitives: the desktop's chat type scale, muted tones,
// kit buttons (`components/kit/button.tsx` sm variants) and the disclosure
// chevron. Values cite `chatTypography.ts` and `kit.css`.
import type { ReactNode } from 'react'
import type { StyleDesc } from '@gpuix/react'
import { Icon } from '../icons.tsx'
import { FONT_MONO, FONT_UI, type Theme } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { T } from './glyphs.ts'
import { G } from '../composer/glyphs.ts'
import { pressTransform } from '../motion/press.ts'

/** `getChatTranscriptTextStyle()`: 14px at `leading-relaxed` (1.625). */
export const TEXT = { size: 14, lineHeight: 22.75 }
/** `getChatMessageFooterTextStyle()`: chat size − 2 at the same leading. */
export const META = { size: 12, lineHeight: 19.5 }
/** Tool and work rows: CHAT_FONT at `leading-6`. */
export const ROW_LINE = 24
export const CODE = { size: 13, lineHeight: 21.125, font: FONT_MONO, radius: 10.4 } // kit.css: .65rem

/** `text-muted-foreground` at an extra opacity (`/65` → 0.65). */
export function muted(t: Theme, alpha = 1): string {
  return ink(t, (t.variant === 'dark' ? 0.58 : 0.598) * alpha)
}

/** A hex or rgb()/rgba() colour at an extra opacity. */
export function alpha(color: string, a: number): string {
  if (color.startsWith('#')) {
    const h = color.slice(1)
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    const base = full.length === 8 ? n(6) / 255 : 1
    return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${Number(Math.min(1, base * a).toFixed(3))})`
  }
  const m = color.match(/rgba?\(([^)]+)\)/)
  if (!m) return color
  const [r, g, b, base = '1'] = m[1].split(/[\s,]+/)
  return `rgba(${r}, ${g}, ${b}, ${Number(Math.min(1, Number(base) * a).toFixed(3))})`
}

/** `text-destructive` at an opacity. */
export const destructive = (t: Theme, a = 1) => alpha(t.red, a)

/** `text-foreground` at an opacity (`text-foreground/92`). */
export const fg = (t: Theme, alpha = 1) => ink(t, alpha)

/** DisclosureChevron: chevron-right that turns down when open (no rotation in GPUIX, so it swaps). */
export function Chevron({ open, color, size = 14 }: { open: boolean; color: string; size?: number }) {
  return <Icon source={open ? T.chevronDown : T.chevronRight} size={size} color={color} />
}

/** The 16px icon slot every work row leads with (`flex size-4`). */
export function RowIcon({ source, color, size = 14, box = 16 }: { source: string; color: string; size?: number; box?: number }) {
  return (
    <div style={{ display: 'flex', width: box, height: box, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Icon source={source} size={size} color={color} />
    </div>
  )
}

type Variant = 'default' | 'chrome-outline' | 'ghost' | 'subtle'

/** Kit `Button` at size `sm`: 28px tall, 9px inline padding, 12px medium label. */
export function Button({
  children,
  variant = 'default',
  onClick,
  disabled,
  testId,
  icon,
  iconAfter,
}: {
  children?: ReactNode
  variant?: Variant
  onClick?: () => void
  disabled?: boolean
  testId?: string
  icon?: string
  iconAfter?: string
}) {
  const t = useTheme()
  const color =
    variant === 'default' ? t.buttonPrimaryText : variant === 'ghost' ? t.textSecondary : t.text
  const base: StyleDesc =
    variant === 'default'
      ? { backgroundColor: t.buttonPrimary, borderColor: 'rgba(0, 0, 0, 0)' }
      : variant === 'chrome-outline'
        ? { borderColor: t.border }
        : variant === 'subtle'
          ? { backgroundColor: t.buttonSecondary, borderColor: 'rgba(0, 0, 0, 0)' }
          : { borderColor: 'rgba(0, 0, 0, 0)' }
  const hover: StyleDesc =
    variant === 'default'
      ? { opacity: 0.9 }
      : variant === 'chrome-outline'
        ? { backgroundColor: t.buttonSecondary }
        : { backgroundColor: t.buttonSecondaryHover }
  return (
    <div
      testId={testId}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onKeyDown={e => { if (!disabled && (e.key === 'enter' || e.key === 'space')) { keyboardAnswer(); onClick?.() } }}
      onClick={disabled ? undefined : onClick}
      paintTransform={pressTransform(!disabled && !!onClick)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 28,
        minWidth: children ? 0 : 28,
        paddingLeft: children ? 9 : 0,
        paddingRight: children ? 9 : 0,
        borderRadius: 8,
        borderWidth: 1,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.64 : 1,
        ...base,
        ...(disabled ? {} : { hover }),
      }}
    >
      {icon && <Icon source={icon} size={16} color={color} style={{ opacity: 0.8 }} />}
      {children != null && (
        <Label color={color} size={12} weight={500} lineHeight={16} style={{ whiteSpace: 'nowrap' }}>
          {children}
        </Label>
      )}
      {iconAfter && <Icon source={iconAfter} size={16} color={color} style={{ opacity: 0.8 }} />}
    </div>
  )
}

/** "1/3" count chip (`h-4 rounded bg-elevated-secondary px-1 text-[9.5px]`). */
export function CountBadge({ text }: { text: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 16, paddingLeft: 4, paddingRight: 4, borderRadius: 4, backgroundColor: t.v('--color-background-elevated-secondary'), flexShrink: 0 }}>
      <Label color={t.textSecondary} size={9.5} weight={500} lineHeight={12}>
        {text}
      </Label>
    </div>
  )
}

/** Plain paragraph text that wraps. */
export function Para({ children, color, size = TEXT.size, lineHeight = TEXT.lineHeight, weight, selectable, style }: { children: string; color: string; size?: number; lineHeight?: number; weight?: number; selectable?: boolean; style?: StyleDesc }) {
  return (
    <text
      style={{
        color,
        fontSize: size,
        lineHeight,
        fontFamily: FONT_UI,
        ...(weight ? { fontWeight: weight } : {}),
        ...(selectable ? { userSelect: 'text' } : {}),
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </text>
  )
}

/** Token colours of Shiki's `github-dark-default` / `github-light-default`, the themes
 *  `lib/highlight.worker.ts` renders transcript code with, mapped onto the native
 *  tree-sitter capture names (TextMate scopes → nearest capture). */
const GITHUB_SYNTAX = {
  dark: { fg: '#e6edf3', comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', constant: '#79c0ff', entity: '#ffa657', fn: '#d2a8ff', tag: '#7ee787', invalid: '#ffa198' },
  light: { fg: '#1f2328', comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', constant: '#0550ae', entity: '#953800', fn: '#8250df', tag: '#116329', invalid: '#82071e' },
} as const
export function githubSyntax(variant: 'dark' | 'light') {
  const c = GITHUB_SYNTAX[variant]
  return { comment: c.comment, keyword: c.keyword, string: c.string, stringSpecial: c.string, escape: c.constant, number: c.constant, boolean: c.constant,
    typeName: c.entity, typeBuiltin: c.entity, constructor: c.entity, function: c.fn, functionBuiltin: c.fn, macroName: c.fn, property: c.constant, constant: c.constant,
    variable: c.fg, variableSpecial: c.constant, parameter: c.entity, operator: c.keyword, punctuation: c.fg, tag: c.tag, attribute: c.constant, label: c.entity, invalid: c.invalid }
}

/** An icon source (`#000` strokes, tinted by the mask elsewhere) with its real colour, for icons drawn as images. */
export const tinted = (svg: string, color: string) => svg.replaceAll('#000', color)
/** `kybern://note/…` and `kybern://task/…` links read as the desktop's chips: an icon before the label. */
function kybernLinkIcons(t: Theme) {
  const chip = t.v('--color-accent-blue')
  return [{ prefix: 'kybern://note/', svg: tinted(T.note, chip), color: '', textColor: chip, weight: 500 }, { prefix: 'kybern://task/', svg: tinted(T.listChecks, chip), color: '', textColor: chip, weight: 500 }]
}

/** Native markdown tokens for chat prose (`.chat-markdown`, kit.css). `tone`
 *  "muted" is the settled work log's `[&_*]:text-muted-foreground`. */
export function markdownTheme(t: Theme, tone: 'bright' | 'muted' = 'bright', codeLineHeight = CODE.size * 1.5) {
  const text = tone === 'muted' ? muted(t) : t.text
  return {
    appearance: t.variant,
    text,
    textMuted: t.textSecondary,
    textFaint: t.textTertiary,
    textDim: t.textSecondary,
    // List markers have their own Markdown token; links use the accent.
    accent: t.link,
    border: t.border,
    codeText: text,
    codeWash: t.codeSurface,
    syntax: githubSyntax(t.variant),
    // WebKit puts a disc's centre 6.2px and `1.` 3.8px from the text; discs are 5.3px; hr margin is 1.5rem.
    markdown: {...transcriptMarkdownStyle(text, t.textSecondary, t.border, t.codeSurface, TEXT.size, CODE.size),listMarkerGap:3.8,listBulletGap:11.15,listMarkerSize:5.3,ruleMargin:24,link:{color:t.v('--color-token-text-link-foreground'),underline:'hover' as const},linkIcons:kybernLinkIcons(t)},
    bg: t.codeSurface,
    fontSans: FONT_UI,
    fontMono: FONT_MONO,
    diffAdd: alpha(t.green, t.variant === 'dark' ? 0.16 : 0.12),
    diffDel: alpha(t.red, t.variant === 'dark' ? 0.16 : 0.12),
    metrics: {
      mdTextSize: TEXT.size,
      mdLineHeight: TEXT.lineHeight,
      mdBlockGap: 10.4,
      mdHeadingSizes: [24.5, 21.7, 18.9, 16.8],
      mdHeadingLineHeights: [30.6, 27.1, 23.6, 21],
      mdInlineCodeRadius: 6.4,
      mdCodeRadius: CODE.radius,
      mdCodePaddingX: 9.6,
      mdCodePaddingY: 8,
      mdCodeHeaderPaddingY: 1.6,
      mdCodeHeaderTextSize: 11.52,
      codeTextSize: CODE.size,
      codeLineHeight,
      diffTextSize: 12,
      diffLineHeight: 19.5,
    },
  }
}

const themeCache = new WeakMap<Theme, Record<string, ReturnType<typeof markdownTheme>>>()
/** One stable theme object per (theme, tone), so memoized native nodes never see a new prop. */
export function cachedMarkdownTheme(t: Theme, tone: 'bright' | 'muted' = 'bright') {
  let entry = themeCache.get(t)
  if (!entry) themeCache.set(t, (entry = {}))
  return (entry[tone] ??= markdownTheme(t, tone))
}

const codeThemeCache = new WeakMap<Theme, ReturnType<typeof markdownTheme>>()
/** Answer fences: `pre` keeps the chat's 22.75px line box (`pre code` is 13px/1.5 inside it), unlike tool output. */
export function cachedCodeTheme(t: Theme) {
  let theme = codeThemeCache.get(t)
  if (!theme) codeThemeCache.set(t, (theme = markdownTheme(t, 'bright', TEXT.lineHeight)))
  return theme
}
