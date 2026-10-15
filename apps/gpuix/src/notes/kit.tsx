// The Notes surface tokens (desktop `styles/notes.css`): colors are mixes of the
// foreground and the surface, so one set follows light and dark.
import { PreferenceHorizontalIcon, Share08Icon } from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'
import { cachedProjectHue } from '../../../../packages/kybern-client/src/projectColors.ts'
import { useApp } from '../state.ts'
import { ink, useTheme } from '../ui.tsx'
import { over } from '../theme.ts'
import type { Theme } from '../theme.ts'

export const NOTES_UI = 14
export const NOTES_META = 13

/** `--n-fg1..4`, `--n-hair`, `--n-fill`, `--n-hover`, `--n-sel`, `--n-card`. */
export function useNotesTokens() {
  const t = useTheme()
  return notesTokens(t)
}
export function notesTokens(t: Theme) {
  const dark = t.variant === 'dark'
  return {
    fg: t.text,
    fg1: ink(t, 0.86),
    fg2: ink(t, 0.6),
    fg3: ink(t, 0.42),
    fg4: ink(t, 0.22),
    hair: ink(t, 0.07),
    fill: ink(t, dark ? 0.05 : 0.04),
    hover: ink(t, 0.035),
    sel: ink(t, dark ? 0.075 : 0.07),
    checkOn: ink(t, dark ? 0.42 : 0.36),
    card: dark ? over(ink(t, 0.05), t.surface) : t.surface,
    cardShadow: dark
      ? { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.25)' }
      : { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.05)' },
    lift: dark
      ? { offsetX: 0, offsetY: 8, blurRadius: 20, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.6)' }
      : { offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: -6, color: 'rgba(0, 0, 0, 0.14)' },
    ring: dark ? 'rgba(255, 255, 255, 0)' : 'rgba(0, 0, 0, 0.09)',
  }
}

/** A 7px dot in the project's hue, or an empty ring for Global (`.project-dot`). */
export function ProjectDot({ projectId }: { projectId: string | null | undefined }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  if (!projectId) return <div style={{ width: 7, height: 7, borderRadius: 3.5, flexShrink: 0, borderWidth: 1.25, borderColor: ink(t, 0.42) }} />
  const hue = cachedProjectHue(projectId, projects)
  const dark = t.variant === 'dark'
  return <div style={{ width: 7, height: 7, borderRadius: 3.5, flexShrink: 0, backgroundColor: `oklch(${dark ? 0.74 : 0.62} ${dark ? 0.1 : 0.13} ${hue})` }} />
}

/** `ChecklistRing`: the done share over a faint track (12px). */
export function Ring({ done, total, color }: { done: number; total: number; color: string }) {
  const share = total > 0 ? Math.min(1, done / total) : 0
  const r = 4.75
  const c = 2 * Math.PI * r
  const track = `<circle cx="6" cy="6" r="${r}" fill="none" stroke="#000" stroke-opacity="0.32" stroke-width="1.4"/>`
  const arc = share > 0 ? `<circle cx="6" cy="6" r="${r}" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="${(share * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 6 6)"/>` : ''
  return <svg source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">${track}${arc}</svg>`} style={{ width: 12, height: 12, flexShrink: 0, color }} />
}

/** The same color fully transparent, so gradients fade without a grey cast. */
export function clear(color: string): string {
  if (color.startsWith('#')) {
    const h = color.slice(1)
    const f = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
    return `rgba(${parseInt(f.slice(0, 2), 16)}, ${parseInt(f.slice(2, 4), 16)}, ${parseInt(f.slice(4, 6), 16)}, 0)`
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(color)
  if (!m) return color
  const [r, g, b] = m[1]!.split(',').map((x) => x.trim())
  return `rgba(${r}, ${g}, ${b}, 0)`
}

/** Display's sliders glyph (`CustomizeIcon`). */
export const CUSTOMIZE = glyph(PreferenceHorizontalIcon)

export const SHARE = glyph(Share08Icon)
