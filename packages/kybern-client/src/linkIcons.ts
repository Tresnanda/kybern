import { chatLink } from './chatLinks.ts'
export type LinkIcon = { kind: 'issue' | 'pull'; owner: string; repo: string; number: number } | { kind: 'github' | 'web' | 'file' | 'none' }
/** What a site icon's visible pixels are: one dark or one light ink, two inks (or a glyph on its own tile), or colour. */
export type FaviconInk = 'dark' | 'light' | 'mixed' | 'color'
export type LinkMetadata = {
  state?: 'open' | 'completed' | 'merged' | 'not_planned' | 'draft'
  /** The site's icon for the default look, a PNG data URL. */
  favicon?: string
  /** WCAG relative luminance (0–1) of the icon's visible pixels, weighted by their alpha. */
  faviconLuminance?: number
  faviconInk?: FaviconInk
  /** The icon the site publishes for dark mode, measured the same way. */
  faviconDark?: string
  faviconDarkLuminance?: number
  faviconDarkInk?: FaviconInk
}
export function classifyLink(href: string): LinkIcon {
  let url: URL
  try { url = new URL(href) } catch { return { kind: chatLink(href).kind === 'file' ? 'file' : 'none' } }
  if (url.protocol === 'file:') return { kind: 'file' }
  if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'none' }
  if (url.hostname.toLowerCase() !== 'github.com') return { kind: 'web' }
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)(?:\/|$)/.exec(url.pathname)
  return match && Number.isSafeInteger(Number(match[4])) ? { kind: match[3] === 'pull' ? 'pull' : 'issue', owner: match[1]!, repo: match[2]!, number: Number(match[4]) } : { kind: 'github' }
}
export function linkStateColor(state: LinkMetadata['state']): string | undefined {
  return state === 'open' ? '#1a7f37' : state === 'completed' || state === 'merged' ? '#8250df' : state === 'not_planned' || state === 'draft' ? '#848d97' : undefined
}
/** Destinations only; the renderer keeps labels and their formatting unchanged. */
export function markdownLinks(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/(?<!!)\[[^\]\n]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g)) out.add((m[1] ?? m[2])!)
  for (const m of source.matchAll(/<?https?:\/\/[^\s<>\])]+/g)) out.add(m[0].replace(/^</, ''))
  return [...out].slice(0, 128).sort((a, b) => b.length - a.length)
}

/** sRGB channels and alpha of a CSS colour: `#rgb`, `#rrggbb(aa)`, `rgb()` or `rgba()`. */
function rgba(color: string): [number, number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1]
  if (hex && [3, 6, 8].includes(hex.length)) {
    const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).concat(full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1) as [number, number, number, number]
  }
  const parts = /^rgba?\(([^)]+)\)$/i.exec(color.trim())?.[1]?.split(/[\s,/]+/).filter(Boolean).map(Number)
  return parts && parts.length >= 3 && parts.every(Number.isFinite) ? [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1] : undefined
}
/** `color` laid over the opaque `under`, as `#rrggbb`; `under` itself when either does not parse. */
export function opaqueColor(color: string, under: string): string {
  const top = rgba(color), base = rgba(under)
  if (!top || !base) return under
  return '#' + [0, 1, 2].map(i => Math.round(top[i]! * top[3] + base[i]! * (1 - top[3])).toString(16).padStart(2, '0')).join('')
}
/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance(color: string): number | undefined {
  const c = rgba(color)
  if (!c) return undefined
  const linear = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
}
export const contrastRatio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
/**
 * The site icon a reply link shows on `background` (opaque), and the plate behind it when it needs one. A dark
 * background takes the site's dark-mode icon when it publishes one. A single-ink icon under 3:1 against the background
 * (WCAG non-text contrast) sits on a plate: the first of `plates` (opaque, quietest first) that reaches 3:1 with the
 * icon, else the last. Two-ink and colourful icons, and icons from daemons that do not measure them, never get one.
 */
export function replyFavicon(data: LinkMetadata, background: string, plates: string[]): { src: string; plate?: string } | undefined {
  const bg = relativeLuminance(background)
  const dark = bg !== undefined && bg < 0.18 && data.faviconDark
  const src = dark ? data.faviconDark : data.favicon
  if (!src) return undefined
  const luminance = dark ? data.faviconDarkLuminance : data.faviconLuminance, ink = dark ? data.faviconDarkInk : data.faviconInk
  if (bg === undefined || luminance === undefined || (ink !== 'dark' && ink !== 'light') || contrastRatio(luminance, bg) >= 3) return { src }
  const plate = plates.find(color => { const l = relativeLuminance(color); return l !== undefined && contrastRatio(luminance, l) >= 3 }) ?? plates.at(-1)
  return plate ? { src, plate } : { src }
}
